import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { ResolveShipmentTracking } from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { contentHash } from '../../common/data/content-hash.js';
import { SeventeenTrackClient } from './seventeentrack.client.js';
import {
  TrackingProviderError,
  normalize17Track,
} from './tracking-normalization.js';

export function registrationLockKey(row: {
  merchantId: string;
  accountKey: string;
  trackingNumber: string;
  requestedCarrier: number;
}) {
  return JSON.stringify({
    merchantId: row.merchantId,
    accountKey: row.accountKey,
    trackingNumber: row.trackingNumber,
  });
}
@Injectable()
export class TrackingRegistrationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(SeventeenTrackClient) private readonly client: SeventeenTrackClient,
  ) {}
  accountKey() {
    return createHash('sha256')
      .update(this.env.SEVENTEENTRACK_API_KEY ?? '')
      .digest('hex');
  }
  async usage(merchantId: string) {
    return this.prisma.trackingUsage.findUnique({
      where: {
        merchantId_day: {
          merchantId,
          day: new Date().toISOString().slice(0, 10),
        },
      },
    });
  }
  private async request(
    merchantId: string,
    endpoint: 'register' | 'gettrackinfo',
    number: string,
    carrier?: number,
    additional: Record<string, string> = {},
  ) {
    const accountKey = this.accountKey();
    const day = new Date().toISOString().slice(0, 10);
    const delay = await this.prisma.$transaction(async (tx) => {
      // One account-wide gate across API instances; no network call holds a DB lock.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tracking-api:${accountKey}`}, 0))::text`;
      const usage = await tx.trackingUsage.upsert({
        where: { merchantId_day: { merchantId, day } },
        create: { merchantId, day },
        update: {},
      });
      if (
        usage.requests >= this.env.SEVENTEENTRACK_DAILY_REQUEST_LIMIT ||
        (endpoint === 'register' &&
          usage.registrationAttempts >=
            this.env.SEVENTEENTRACK_DAILY_REGISTRATION_LIMIT)
      )
        throw new TrackingProviderError(
          'TRACK17_MERCHANT_DAILY_LIMIT',
          true,
          null,
          86400000,
        );
      const gate = await tx.trackingApiGate.findUnique({
        where: { accountKey },
      });
      const next = Math.max(Date.now(), gate?.nextRequestAt.getTime() ?? 0);
      if (next - Date.now() > 1000)
        throw new TrackingProviderError(
          'TRACK17_RATE_LIMIT',
          true,
          429,
          next - Date.now(),
        );
      await tx.trackingApiGate.upsert({
        where: { accountKey },
        create: { accountKey, nextRequestAt: new Date(next + 400) },
        update: { nextRequestAt: new Date(next + 400) },
      });
      await tx.trackingUsage.update({
        where: { merchantId_day: { merchantId, day } },
        data: {
          requests: { increment: 1 },
          ...(endpoint === 'register'
            ? { registrationAttempts: { increment: 1 } }
            : { queries: { increment: 1 } }),
        },
      });
      return Math.max(0, next - Date.now());
    });
    if (delay) await pause(delay);
    try {
      return await this.client.request(endpoint, number, carrier, additional);
    } catch (e) {
      if (e instanceof TrackingProviderError && e.providerCode === 429) {
        const until = new Date(Date.now() + Math.max(2000, e.retryAfterMs));
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tracking-api:${accountKey}`}, 0))::text`;
          const current = await tx.trackingApiGate.findUniqueOrThrow({
            where: { accountKey },
          });
          if (current.nextRequestAt < until)
            await tx.trackingApiGate.update({
              where: { accountKey },
              data: { nextRequestAt: until },
            });
        });
      }
      await this.prisma.trackingUsage.update({
        where: { merchantId_day: { merchantId, day } },
        data: { failures: { increment: 1 } },
      });
      throw e;
    }
  }
  async fetch(
    merchantId: string,
    number: string,
    input: ResolveShipmentTracking,
  ) {
    if (!this.env.SEVENTEENTRACK_API_KEY)
      throw new TrackingProviderError('TRACK17_NOT_CONFIGURED');
    const key = {
      merchantId,
      accountKey: this.accountKey(),
      trackingNumber: number,
      requestedCarrier: input.carrierCode ?? 0,
    };
    const parametersHash = contentHash({
      postalCode: input.destinationPostalCode ?? null,
      originCountry: input.originCountry ?? null,
      shipDate: input.shipDate ?? null,
    });
    const leaseToken = randomUUID();
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${registrationLockKey(key)}, 0))::text`;
      const exact = await tx.trackingRegistration.findUnique({
        where: { merchantId_accountKey_trackingNumber_requestedCarrier: key },
      });
      const aliases = exact
        ? []
        : await tx.trackingRegistration.findMany({
            where: {
              merchantId,
              accountKey: key.accountKey,
              trackingNumber: number,
              status: { in: ['REGISTERED', 'STOPPED'] },
              ...(input.carrierCode ? { carrier: input.carrierCode } : {}),
            },
            orderBy: { updatedAt: 'desc' },
            take: 20,
          });
      if (
        !exact &&
        !input.carrierCode &&
        new Set(aliases.map((a) => a.carrier)).size > 1
      )
        throw new TrackingProviderError('TRACK17_AMBIGUOUS_CARRIER');
      let current =
        exact ??
        aliases[0] ??
        (await tx.trackingRegistration.create({
          data: { ...key, parametersHash },
        }));
      if (
        current.lastResult &&
        current.lastCheckedAt &&
        Date.now() - current.lastCheckedAt.getTime() <
          (normalize17Track(current.lastResult, current.origin).events.length
            ? this.env.SHIPMENT_TRACKING_CACHE_SECONDS * 1000
            : 30000)
      )
        return current;
      const active = await tx.trackingRegistration.count({
        where: {
          merchantId,
          accountKey: key.accountKey,
          trackingNumber: number,
          leaseExpiresAt: { gt: new Date() },
        },
      });
      if (active)
        throw new TrackingProviderError('TRACK17_SYNC_BUSY', true, null, 30000);
      if (current.status === 'STOPPED')
        throw new TrackingProviderError('TRACK17_TRACKING_STOPPED');
      if (
        current.leaseExpiresAt &&
        current.leaseExpiresAt.getTime() > Date.now()
      )
        throw new TrackingProviderError('TRACK17_SYNC_BUSY', true, null, 30000);
      if (input.retryFailed && current.errorCode) {
        current = await tx.trackingRegistration.update({
          where: { id: current.id },
          data: {
            errorCode: null,
            providerCode: null,
            failures: 0,
            nextAttemptAt: null,
            status: current.status === 'FAILED' ? 'NEW' : current.status,
          },
        });
      }
      if (
        current.status === 'FAILED' &&
        current.parametersHash !== parametersHash
      ) {
        // Definite registration rejection: new required fields may safely retry.
        current = await tx.trackingRegistration.update({
          where: { id: current.id },
          data: {
            status: 'NEW',
            parametersHash,
            errorCode: null,
            providerCode: null,
            failures: 0,
            nextAttemptAt: null,
          },
        });
      }
      if (
        current.errorCode &&
        (!current.nextAttemptAt || current.nextAttemptAt.getTime() > Date.now())
      )
        throw new TrackingProviderError(
          current.errorCode,
          current.nextAttemptAt !== null,
          current.providerCode,
          Math.max(
            0,
            (current.nextAttemptAt?.getTime() ?? Date.now()) - Date.now(),
          ),
        );
      return tx.trackingRegistration.update({
        where: { id: current.id },
        data: {
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 120000),
          status: current.status === 'REGISTERING' ? 'UNKNOWN' : current.status,
        },
      });
    });
    if (row.leaseToken !== leaseToken)
      return {
        original: row.lastResult! as Record<string, unknown>,
        observation: normalize17Track(row.lastResult, row.origin),
      };
    let registered = row.status === 'REGISTERED';
    let carrier = row.carrier ?? input.carrierCode;
    let origin = row.origin;
    try {
      let original: Record<string, unknown> | undefined;
      if (row.status === 'UNKNOWN') {
        try {
          original = await this.request(
            merchantId,
            'gettrackinfo',
            number,
            carrier,
          );
          registered = true;
        } catch (e) {
          if (
            !(e instanceof TrackingProviderError) ||
            e.code !== 'TRACK17_NOT_REGISTERED'
          )
            throw e;
        }
      }
      if (!registered) {
        await this.prisma.trackingRegistration.update({
          where: { id: row.id, leaseToken },
          data: { status: 'REGISTERING' },
        });
        const additional: Record<string, string> = {};
        if (input.destinationPostalCode)
          additional.destination_postal_code = input.destinationPostalCode;
        if (input.originCountry)
          additional.origin_country = input.originCountry;
        if (input.shipDate) additional.ship_date = input.shipDate;
        try {
          const receipt = await this.request(
            merchantId,
            'register',
            number,
            carrier,
            additional,
          );
          carrier =
            typeof receipt.carrier === 'number' && receipt.carrier > 0
              ? receipt.carrier
              : carrier;
          origin = typeof receipt.origin === 'number' ? receipt.origin : null;
          await this.prisma.trackingUsage.upsert({
            where: {
              merchantId_day: {
                merchantId,
                day: new Date().toISOString().slice(0, 10),
              },
            },
            create: {
              merchantId,
              day: new Date().toISOString().slice(0, 10),
              registrations: 1,
            },
            update: { registrations: { increment: 1 } },
          });
        } catch (e) {
          if (
            !(e instanceof TrackingProviderError) ||
            e.code !== 'TRACK17_ALREADY_REGISTERED'
          )
            throw e;
        }
        registered = true;
        await this.prisma.trackingRegistration.update({
          where: { id: row.id, leaseToken },
          data: { status: 'REGISTERED', carrier, origin },
        });
      }
      original ??= await this.request(
        merchantId,
        'gettrackinfo',
        number,
        carrier,
      );
      const observation = normalize17Track(original, origin);
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${registrationLockKey(key)}, 0))::text`;
        const current = await tx.trackingRegistration.findUniqueOrThrow({
          where: { id: row.id },
        });
        if (current.leaseToken !== leaseToken)
          throw new TrackingProviderError(
            'TRACK17_SYNC_BUSY',
            true,
            null,
            30000,
          );
        const previous = current.lastResult
          ? normalize17Track(current.lastResult, current.origin)
          : null;
        const preserve =
          previous &&
          ((previous.updatedAt &&
            (!observation.updatedAt ||
              previous.updatedAt > observation.updatedAt)) ||
            (previous.events.length && !observation.events.length));
        const result = preserve
          ? {
              original: current.lastResult as Record<string, unknown>,
              observation: previous,
            }
          : { original, observation };
        await tx.trackingRegistration.update({
          where: { id: row.id, leaseToken },
          data: {
            status: current.status === 'STOPPED' ? 'STOPPED' : 'REGISTERED',
            carrier: result.observation.carrierCode,
            origin,
            lastResult: result.original as Prisma.InputJsonValue,
            lastCheckedAt: new Date(),
            failures: 0,
            errorCode:
              current.status === 'STOPPED' ? 'TRACK17_TRACKING_STOPPED' : null,
            providerCode: null,
            nextAttemptAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return result;
      });
    } catch (e) {
      const error =
        e instanceof TrackingProviderError
          ? e
          : new TrackingProviderError('TRACK17_INVALID_RESPONSE');
      const failures = row.failures + 1;
      await this.prisma.trackingRegistration.updateMany({
        where: { id: row.id, leaseToken },
        data: {
          status: registered
            ? 'REGISTERED'
            : error.retryable
              ? 'UNKNOWN'
              : 'FAILED',
          failures,
          errorCode: error.code,
          providerCode: error.providerCode,
          nextAttemptAt:
            error.retryable && failures < 5
              ? new Date(
                  Date.now() +
                    Math.max(error.retryAfterMs, 30000 * 2 ** (failures - 1)),
                )
              : null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      throw error;
    }
  }
}
