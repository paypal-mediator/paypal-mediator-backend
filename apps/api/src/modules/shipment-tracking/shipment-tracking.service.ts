import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ResolveShipmentTrackingSchema,
  ShipmentObservationSchema,
  ShipmentTrackingResponseSchema,
  TrackingNumberSchema,
  TrackingSourceAttemptSchema,
  type ResolveShipmentTracking,
  type ShipmentObservation,
  type TrackingSourceAttempt,
} from '@resolve-ai/contracts';
import { z } from 'zod';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { contentHash } from '../../common/data/content-hash.js';
import { ApiException } from '../../common/http/api.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import { TransactionsService } from '../transactions/index.js';
import { DisputesService } from '../disputes/index.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { EvidenceService } from '../evidence/index.js';
import { PayPalTrackingSource } from './paypal-tracking.source.js';
import { TrackingRegistrationService } from './tracking-registration.service.js';
import {
  discrepancies,
  normalizeErp,
  sortedEvents,
  TrackingProviderError,
  useful,
} from './tracking-normalization.js';

type Fetched = {
  observation: ShipmentObservation;
  original: Record<string, unknown>;
};
@Injectable()
export class ShipmentTrackingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(DisputesService) private readonly disputes: DisputesService,
    @Inject(IntegrationsService)
    private readonly integrations: IntegrationsService,
    @Inject(EvidenceService) private readonly evidence: EvidenceService,
    @Inject(PayPalTrackingSource) private readonly paypal: PayPalTrackingSource,
    @Inject(TrackingRegistrationService)
    private readonly track17: TrackingRegistrationService,
  ) {}
  async schedule(
    merchantId: string,
    transactionId: string,
    disputeEventAt?: Date,
  ) {
    const job = await this.prisma.shipmentTrackingJob.upsert({
      where: { transactionId },
      create: { merchantId, transactionId },
      update: {},
    });
    if (
      disputeEventAt &&
      (!job.lastDisputeEventAt || job.lastDisputeEventAt < disputeEventAt)
    )
      await this.prisma.shipmentTrackingJob.updateMany({
        where: {
          transactionId,
          merchantId,
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: new Date() } },
          ],
        },
        data: { lastDisputeEventAt: disputeEventAt, nextAttemptAt: new Date() },
      });
  }
  private async snapshots(merchantId: string, transactionId: string) {
    const rows = await this.prisma.shipmentTrackingSnapshot.findMany({
      where: { merchantId, transactionId },
      orderBy: { retrievedAt: 'desc' },
      take: 1000,
    });
    const map = new Map<string, ShipmentObservation>();
    for (const row of rows) {
      if (
        contentHash({
          observation: row.observation,
          original: row.original,
        }) !== row.contentHash
      )
        continue;
      const parsed = ShipmentObservationSchema.safeParse(row.observation);
      if (!parsed.success) continue;
      const o = parsed.data;
      const key = `${o.source}:${o.sourceSystem}:${o.trackingNumber}:${row.carrierKey}`;
      const current = map.get(key);
      if (
        !current ||
        (!current.events.length && o.events.length) ||
        (o.updatedAt && (!current.updatedAt || o.updatedAt > current.updatedAt))
      )
        map.set(key, o);
    }
    return [...map.values()];
  }
  async read(merchantId: string, transactionId: string) {
    const { row, evidence } = await this.transactions.trackingContext(
      merchantId,
      transactionId,
    );
    const [job, all, links] = await Promise.all([
      this.prisma.shipmentTrackingJob.findFirst({
        where: { merchantId, transactionId },
      }),
      this.snapshots(merchantId, transactionId),
      this.disputes.trackingLinks(merchantId, transactionId),
    ]);
    const input = ResolveShipmentTrackingSchema.parse(job?.input ?? {});
    const scoped = all.filter(
      (o) => !input.trackingNumber || o.trackingNumber === input.trackingNumber,
    );
    const observations = all;
    const issues = discrepancies(scoped);
    if (
      job?.errorCode === 'MULTIPLE_TRACKING_NUMBERS' &&
      !issues.includes('MULTIPLE_TRACKING_NUMBERS')
    )
      issues.push('MULTIPLE_TRACKING_NUMBERS');
    if (
      !input.trackingNumber &&
      new Set(observations.map((o) => o.trackingNumber)).size > 1
    )
      issues.push('MULTIPLE_TRACKING_NUMBERS');
    const rank = { paypal: 0, erp: 1, '17track': 2 };
    const ordered = [...scoped].sort((a, b) => rank[a.source] - rank[b.source]);
    const selected =
      ordered.find((o) => useful(o, this.env.SHIPMENT_TRACKING_FRESH_HOURS)) ??
      ordered.find((o) => o.events.length) ??
      ordered[0] ??
      null;
    const state =
      job?.status === 'SYNCING'
        ? 'SYNCING'
        : issues.length || job?.status === 'NEEDS_REVIEW'
          ? 'NEEDS_REVIEW'
          : selected && useful(selected, this.env.SHIPMENT_TRACKING_FRESH_HOURS)
            ? 'CURRENT'
            : job?.status === 'FAILED' || job?.status === 'NOT_CONFIGURED'
              ? job.status
              : selected?.events.length
                ? 'STALE'
                : (job?.status ?? 'PENDING');
    return ShipmentTrackingResponseSchema.parse({
      transactionId: row.id,
      orderId:
        row.merchantOrderId ?? evidence.order?.externalId ?? row.paypalOrderId,
      disputeIds: links.map((l) => l.id),
      state,
      selected,
      observations,
      discrepancies: issues,
      attempts: z
        .array(TrackingSourceAttemptSchema)
        .parse(job?.sourceAttempts ?? []),
      lastAttemptAt: job?.lastAttemptAt?.toISOString() ?? null,
      nextAttemptAt: job?.nextAttemptAt?.toISOString() ?? null,
      errorCode: job?.errorCode ?? null,
    });
  }
  async readForDispute(merchantId: string, id: string) {
    const dispute = await this.disputes.detail(merchantId, id);
    if (!dispute.link.transactionId || dispute.link.status !== 'LINKED')
      throw new ApiException(
        'DISPUTE_TRANSACTION_NOT_LINKED',
        'Dispute has no unambiguous transaction',
        409,
      );
    return this.read(merchantId, dispute.link.transactionId);
  }
  async resolveForDispute(
    merchantId: string,
    id: string,
    input: ResolveShipmentTracking,
  ) {
    const dispute = await this.disputes.detail(merchantId, id);
    if (!dispute.link.transactionId || dispute.link.status !== 'LINKED')
      throw new ApiException(
        'DISPUTE_TRANSACTION_NOT_LINKED',
        'Dispute has no unambiguous transaction',
        409,
      );
    return this.resolveShipmentTracking(
      merchantId,
      dispute.link.transactionId,
      input,
    );
  }
  async resolveShipmentTracking(
    merchantId: string,
    transactionId: string,
    supplied: ResolveShipmentTracking = {},
  ) {
    const context = await this.transactions.trackingContext(
      merchantId,
      transactionId,
    );
    const { retryFailed, ...parsed } =
      ResolveShipmentTrackingSchema.parse(supplied);
    const leaseToken = randomUUID();
    const job = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shipment:${transactionId}`},0))::text`;
      const current = await tx.shipmentTrackingJob.upsert({
        where: { transactionId },
        create: { transactionId, merchantId },
        update: {},
      });
      if (current.merchantId !== merchantId)
        throw new ApiException(
          'TRANSACTION_NOT_FOUND',
          'Transaction not found',
          404,
        );
      const input = {
        ...ResolveShipmentTrackingSchema.parse(current.input),
        ...parsed,
      };
      const changed =
        retryFailed === true ||
        contentHash(input) !== contentHash(current.input) ||
        current.providerAccountKey !== this.track17.accountKey();
      if (current.leaseExpiresAt && current.leaseExpiresAt > new Date())
        return null;
      if (
        !changed &&
        !(
          current.status === 'SYNCING' &&
          current.leaseExpiresAt &&
          current.leaseExpiresAt <= new Date()
        ) &&
        (current.nextAttemptAt === null || current.nextAttemptAt > new Date())
      )
        return null;
      return tx.shipmentTrackingJob.update({
        where: { transactionId },
        data: {
          input,
          providerAccountKey: this.track17.accountKey(),
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 180000),
          status: 'SYNCING',
          attempts: { increment: 1 },
          failures: changed ? 0 : current.failures,
          lastAttemptAt: new Date(),
          nextAttemptAt: null,
        },
      });
    });
    if (!job) return this.read(merchantId, transactionId);
    const input = ResolveShipmentTrackingSchema.parse(job.input);
    const fetched: Fetched[] = [];
    const attempts: TrackingSourceAttempt[] = [];
    let retryAfter = 0;
    let hasTemporary = false;
    let hasPermanent = false;
    const captureError = (
      source: TrackingSourceAttempt['source'],
      error: unknown,
    ) => {
      const e =
        error instanceof TrackingProviderError
          ? error
          : new TrackingProviderError('TRACKING_SOURCE_UNAVAILABLE', true);
      hasTemporary ||= e.retryable;
      hasPermanent ||= !e.retryable && !e.code.endsWith('NOT_CONFIGURED');
      retryAfter = Math.max(retryAfter, e.retryAfterMs);
      attempts.push({
        source,
        state: e.code.endsWith('NOT_CONFIGURED')
          ? 'NOT_CONFIGURED'
          : e.retryable
            ? 'TEMPORARY_ERROR'
            : 'PERMANENT_ERROR',
        errorCode: e.code,
        providerCode: e.providerCode,
      });
    };
    const assess = (
      source: TrackingSourceAttempt['source'],
      rows: Fetched[],
    ) => {
      attempts.push({
        source,
        state: discrepancies(rows.map((r) => r.observation)).length
          ? 'CONTRADICTORY'
          : rows.some((r) =>
                useful(r.observation, this.env.SHIPMENT_TRACKING_FRESH_HOURS),
              )
            ? 'AVAILABLE'
            : rows.some((r) => r.observation.events.length)
              ? 'STALE'
              : 'ABSENT',
        errorCode: null,
        providerCode: null,
      });
      fetched.push(...rows);
    };
    let state = 'NO_DATA';
    let discoveredNumber: string | undefined;
    try {
      try {
        assess(
          'paypal',
          await this.paypal.fetch(context.row, input.trackingNumber),
        );
      } catch (e) {
        captureError('paypal', e);
      }
      if (
        !fetched.some((f) =>
          useful(f.observation, this.env.SHIPMENT_TRACKING_FRESH_HOURS),
        )
      ) {
        try {
          const result = await this.integrations.shipmentRecords({
            merchantId,
            paypalCaptureId: context.row.paypalCaptureId,
            paypalOrderId: context.row.paypalOrderId,
            merchantOrderReference: context.row.merchantOrderReference,
            invoiceId: context.row.invoiceId,
            orderExternalId: context.evidence.order?.externalId ?? null,
          });
          const rows = result.records.flatMap((record) => {
            const observation = normalizeErp(
              record.original,
              `erp:${record.provider}`,
              record.containsDemo,
            );
            return observation &&
              (!input.trackingNumber ||
                observation.trackingNumber === input.trackingNumber)
              ? [{ original: record.original, observation }]
              : [];
          });
          assess('erp', rows);
          if (result.errors.length)
            captureError(
              'erp',
              new TrackingProviderError('ERP_SHIPMENTS_UNAVAILABLE', true),
            );
        } catch (e) {
          captureError('erp', e);
        }
      }
      const dossier = await this.transactions.dossier(
        merchantId,
        transactionId,
      );
      const evidenceGuides = dossier.items
        .filter(
          (i) =>
            i.current &&
            i.integrity === 'VALID' &&
            ['TRACKING', 'PROOF_OF_DELIVERY'].includes(i.type) &&
            i.content.status !== 'CANCELLED' &&
            i.content.status !== 'RETRACTED',
        )
        .flatMap((i) => {
          const guide = TrackingNumberSchema.safeParse(
            i.content.trackingNumber,
          );
          return guide.success
            ? [{ number: guide.data, demo: i.sourceKind === 'DEMO' }]
            : [];
        });
      const guides = input.trackingNumber
        ? [input.trackingNumber]
        : [
            ...new Set([
              ...fetched
                .filter((f) => !f.observation.containsDemo)
                .map((f) => f.observation.trackingNumber),
              ...evidenceGuides.filter((g) => !g.demo).map((g) => g.number),
            ]),
          ];
      if (guides.length > 1) state = 'NEEDS_REVIEW';
      else if (!guides.length) state = 'NO_TRACKING_NUMBER';
      else {
        discoveredNumber = guides[0]!;
        // A guide discovered at ERP/evidence must still get a PayPal read first.
        if (
          !input.trackingNumber &&
          !fetched.some(
            (f) =>
              f.observation.source === 'paypal' &&
              f.observation.trackingNumber === discoveredNumber,
          )
        ) {
          try {
            assess(
              'paypal',
              await this.paypal.fetch(context.row, discoveredNumber),
            );
          } catch (e) {
            captureError('paypal', e);
          }
        }
        const prior = await this.snapshots(merchantId, transactionId);
        const candidates = [
          ...fetched.map((f) => f.observation),
          ...prior,
        ].filter((o) => o.trackingNumber === discoveredNumber);
        if (
          !candidates.some((o) =>
            useful(o, this.env.SHIPMENT_TRACKING_FRESH_HOURS),
          )
        ) {
          const demoOnly =
            !input.trackingNumber &&
            fetched.some(
              (f) =>
                f.observation.containsDemo &&
                f.observation.trackingNumber === discoveredNumber,
            );
          if (!demoOnly) {
            try {
              const carrierCodes = [
                ...new Set(
                  fetched
                    .filter(
                      (f) =>
                        f.observation.trackingNumber === discoveredNumber &&
                        !f.observation.containsDemo,
                    )
                    .flatMap((f) =>
                      f.observation.carrierCode
                        ? [f.observation.carrierCode]
                        : [],
                    ),
                ),
              ];
              if (!input.carrierCode && carrierCodes.length === 1)
                input.carrierCode = carrierCodes[0]!;
              const result = await this.track17.fetch(
                merchantId,
                discoveredNumber,
                { ...input, ...(retryFailed ? { retryFailed } : {}) },
              );
              assess('17track', [result]);
              if (!result.observation.events.length)
                captureError(
                  '17track',
                  new TrackingProviderError('TRACK17_NO_DATA', true),
                );
            } catch (e) {
              captureError('17track', e);
            }
          }
        }
        state = fetched.some((f) => f.observation.events.length)
          ? 'STALE'
          : 'NO_DATA';
      }
      const issues = discrepancies(fetched.map((f) => f.observation));
      if (guides.length > 1) issues.push('MULTIPLE_TRACKING_NUMBERS');
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shipment:${transactionId}`},0))::text`;
          const current = await tx.shipmentTrackingJob.findUniqueOrThrow({
            where: { transactionId },
          });
          if (current.leaseToken !== leaseToken) return;
          for (const result of fetched)
            await this.persist(tx, merchantId, transactionId, result, issues);
          const hasUsable = fetched.some((f) =>
            useful(f.observation, this.env.SHIPMENT_TRACKING_FRESH_HOURS),
          );
          const failures =
            !hasUsable && (hasTemporary || hasPermanent) ? job.failures + 1 : 0;
          const terminalError =
            attempts.some(
              (a) => a.source === '17track' && a.state === 'PERMANENT_ERROR',
            ) &&
            !fetched.some((f) =>
              useful(f.observation, this.env.SHIPMENT_TRACKING_FRESH_HOURS),
            );
          const notConfigured =
            !fetched.length &&
            attempts.some(
              (a) => a.source === '17track' && a.state === 'NOT_CONFIGURED',
            );
          await tx.shipmentTrackingJob.update({
            where: { transactionId },
            data: {
              status: issues.length
                ? 'NEEDS_REVIEW'
                : notConfigured
                  ? 'NOT_CONFIGURED'
                  : terminalError
                    ? 'FAILED'
                    : state,
              input:
                input.trackingNumber || !discoveredNumber
                  ? input
                  : { ...input, trackingNumber: discoveredNumber },
              sourceAttempts: attempts,
              errorCode:
                issues[0] ??
                attempts.filter((a) => a.errorCode).at(-1)?.errorCode ??
                null,
              failures,
              leaseToken: null,
              leaseExpiresAt: null,
              nextAttemptAt:
                terminalError || failures >= 5
                  ? null
                  : new Date(
                      Date.now() +
                        (hasTemporary && !hasUsable
                          ? Math.max(retryAfter, 30000 * 2 ** (failures - 1))
                          : this.env.SHIPMENT_TRACKING_CACHE_SECONDS * 1000),
                    ),
            },
          });
        },
        { timeout: 15000 },
      );
    } catch (e) {
      await this.prisma.shipmentTrackingJob.updateMany({
        where: { transactionId, leaseToken },
        data: {
          status: 'FAILED',
          errorCode: 'TRACKING_PROCESSING_FAILED',
          sourceAttempts: attempts,
          failures: { increment: 1 },
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: job.failures < 4 ? new Date(Date.now() + 60000) : null,
        },
      });
      if (e instanceof ApiException && e.getStatus() === 404) throw e;
    }
    return this.read(merchantId, transactionId);
  }
  async persist(
    tx: Prisma.TransactionClient,
    merchantId: string,
    transactionId: string,
    result: Fetched,
    issues: string[] = [],
  ) {
    // Same lock order used by M03/M04: serialize updates to this dossier.
    const context = await this.transactions.trackingContext(
      merchantId,
      transactionId,
      tx,
      true,
    );
    const o = result.observation;
    const carrierKey = String(o.carrierCode ?? o.carrier ?? 'unknown');
    const old = await tx.shipmentTrackingSnapshot.findMany({
      where: {
        merchantId,
        transactionId,
        source: o.source,
        trackingNumber: o.trackingNumber,
        carrierKey,
      },
      orderBy: { retrievedAt: 'desc' },
      take: 20,
    });
    const events = old.flatMap((s) => {
      const parsed = ShipmentObservationSchema.safeParse(s.observation);
      return parsed.success &&
        contentHash({ observation: s.observation, original: s.original }) ===
          s.contentHash
        ? parsed.data.events
        : [];
    });
    const latest = old
      .flatMap((s) => {
        const parsed = ShipmentObservationSchema.safeParse(s.observation);
        return parsed.success &&
          contentHash({ observation: s.observation, original: s.original }) ===
            s.contentHash
          ? [parsed.data]
          : [];
      })
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
    // Keep a complete, newer normalized report when a provider returns sparse/older data.
    const effective =
      latest &&
      latest.updatedAt &&
      (!o.updatedAt ||
        o.updatedAt < latest.updatedAt ||
        !o.events.length ||
        o.status === 'UNKNOWN' ||
        (o.issues.length > 0 && latest.issues.length === 0))
        ? latest
        : o;
    const observation = {
      ...effective,
      events: sortedEvents([...events, ...o.events]).slice(-2000),
    };
    const content = { observation, original: result.original };
    const hash = contentHash(content);
    const key = {
      transactionId,
      source: o.source,
      trackingNumber: o.trackingNumber,
      carrierKey,
      contentHash: hash,
    };
    const existing = await tx.shipmentTrackingSnapshot.findUnique({
      where: {
        transactionId_source_trackingNumber_carrierKey_contentHash: key,
      },
    });
    const receipt = await this.evidence.recordShipmentTracking(
      tx,
      context.evidence,
      {
        sourceKind: o.containsDemo
          ? 'DEMO'
          : o.source === 'paypal'
            ? 'PAYPAL'
            : 'CONNECTED_SYSTEM',
        sourceSystem: o.sourceSystem,
        externalReference: contentHash([o.trackingNumber, carrierKey]),
        content: {
          ...content,
          discrepancies: issues,
          transactionId,
          orderId:
            context.evidence.order?.externalId ?? context.row.paypalOrderId,
          paypalCaptureId: context.row.paypalCaptureId,
          documentaryProof: false,
        },
      },
    );
    if (!existing)
      await tx.shipmentTrackingSnapshot.create({
        data: {
          ...key,
          merchantId,
          observation: observation as Prisma.InputJsonValue,
          original: result.original as Prisma.InputJsonValue,
          evidenceId: receipt.evidenceId,
        },
      });
  }
}
