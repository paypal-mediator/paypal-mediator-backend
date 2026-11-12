import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  TrackingRegistrationService,
  registrationLockKey,
} from './tracking-registration.service.js';
import { ShipmentTrackingService } from './shipment-tracking.service.js';
import {
  normalize17Track,
  Tracking17ItemSchema,
} from './tracking-normalization.js';
import { contentHash } from '../../common/data/content-hash.js';

const updated = z.object({
  event: z.literal('TRACKING_UPDATED'),
  data: z.union([
    Tracking17ItemSchema,
    z.object({ accepted: z.array(Tracking17ItemSchema).min(1).max(40) }),
  ]),
});
const stopped = z.object({
  event: z.literal('TRACKING_STOPPED'),
  data: z.object({ number: z.string(), carrier: z.number().int().positive() }),
});
@Injectable()
export class TrackingWebhookService {
  constructor(
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TrackingRegistrationService)
    private readonly registrations: TrackingRegistrationService,
    @Inject(ShipmentTrackingService)
    private readonly tracking: ShipmentTrackingService,
  ) {}
  async receive(rawBody: Buffer | undefined, signature: string | undefined) {
    if (
      !this.env.SEVENTEENTRACK_WEBHOOK_ENABLED ||
      !this.env.SEVENTEENTRACK_API_KEY
    )
      throw new ApiException(
        'TRACK17_WEBHOOK_NOT_CONFIGURED',
        'Tracking webhook is not configured',
        503,
      );
    if (!rawBody || !signature || !/^[a-f0-9]{64}$/i.test(signature))
      throw new ApiException(
        'TRACK17_INVALID_SIGNATURE',
        'Invalid webhook signature',
        401,
      );
    const digest = createHash('sha256')
      .update(rawBody)
      .update('/')
      .update(this.env.SEVENTEENTRACK_API_KEY)
      .digest();
    if (!timingSafeEqual(digest, Buffer.from(signature, 'hex')))
      throw new ApiException(
        'TRACK17_INVALID_SIGNATURE',
        'Invalid webhook signature',
        401,
      );
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new ApiException(
        'TRACK17_INVALID_WEBHOOK',
        'Invalid tracking webhook',
        400,
      );
    }
    const parsed = z.union([updated, stopped]).safeParse(raw);
    if (!parsed.success)
      throw new ApiException(
        'TRACK17_INVALID_WEBHOOK',
        'Invalid tracking webhook',
        400,
      );
    const message = parsed.data;
    const items =
      message.event === 'TRACKING_STOPPED'
        ? [message.data]
        : Array.isArray(message.data.accepted)
          ? (message.data.accepted as Array<
              z.infer<typeof Tracking17ItemSchema>
            >)
          : [message.data as z.infer<typeof Tracking17ItemSchema>];
    for (const item of items) {
      const rows = await this.prisma.trackingRegistration.findMany({
        where: {
          accountKey: this.registrations.accountKey(),
          trackingNumber: item.number,
          OR: [
            { carrier: item.carrier },
            {
              carrier: null,
              status: { in: ['REGISTERING', 'UNKNOWN', 'REGISTERED'] },
            },
          ],
        },
      });
      for (const registration of rows) {
        if (message.event === 'TRACKING_STOPPED') {
          await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${registrationLockKey(registration)}, 0))::text`;
            await tx.trackingRegistration.update({
              where: { id: registration.id },
              data: {
                status: 'STOPPED',
                errorCode: 'TRACK17_TRACKING_STOPPED',
                nextAttemptAt: null,
                leaseToken: null,
                leaseExpiresAt: null,
              },
            });
          });
          continue;
        }
        const original = item as Record<string, unknown>;
        const observation = normalize17Track(original, registration.origin);
        await this.prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${registrationLockKey(registration)}, 0))::text`;
            const currentRegistration =
              await tx.trackingRegistration.findUniqueOrThrow({
                where: { id: registration.id },
              });
            const jobs = await tx.shipmentTrackingJob.findMany({
              where: {
                merchantId: registration.merchantId,
                input: { path: ['trackingNumber'], equals: item.number },
              },
              orderBy: { transactionId: 'asc' },
            });
            for (const job of jobs) {
              await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shipment:${job.transactionId}`},0))::text`;
            }
            for (const job of jobs) {
              const input = job.input as Record<string, unknown>;
              if (
                typeof input.carrierCode === 'number' &&
                input.carrierCode !== registration.requestedCarrier &&
                input.carrierCode !== registration.carrier
              )
                continue;
              await this.tracking.persist(
                tx,
                registration.merchantId,
                job.transactionId,
                { original, observation },
              );
              await tx.shipmentTrackingJob.updateMany({
                where: { transactionId: job.transactionId, leaseToken: null },
                data: {
                  failures: 0,
                  errorCode: null,
                  nextAttemptAt: new Date(
                    Date.now() +
                      this.env.SHIPMENT_TRACKING_CACHE_SECONDS * 1000,
                  ),
                },
              });
            }
            const previous = currentRegistration.lastResult
              ? normalize17Track(
                  currentRegistration.lastResult,
                  currentRegistration.origin,
                )
              : null;
            if (
              !previous?.updatedAt ||
              (observation.updatedAt &&
                observation.updatedAt >= previous.updatedAt &&
                observation.events.length > 0 &&
                (observation.status !== 'UNKNOWN' ||
                  previous.status === 'UNKNOWN'))
            ) {
              await tx.trackingRegistration.update({
                where: { id: registration.id },
                data: {
                  lastResult: original as Prisma.InputJsonValue,
                  lastCheckedAt: new Date(),
                  carrier: item.carrier,
                  status: 'REGISTERED',
                  errorCode: null,
                  providerCode: null,
                  nextAttemptAt: null,
                  failures: 0,
                },
              });
            }
            if (
              contentHash(currentRegistration.lastResult) !==
              contentHash(original)
            ) {
              const merchantId = registration.merchantId,
                day = new Date().toISOString().slice(0, 10);
              await tx.trackingUsage.upsert({
                where: { merchantId_day: { merchantId, day } },
                create: { merchantId, day, webhooks: 1 },
                update: { webhooks: { increment: 1 } },
              });
            }
          },
          { timeout: 15000 },
        );
      }
    }
    return { accepted: true };
  }
}
