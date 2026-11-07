import {
  TrackingContentSchema,
  DeliveryContentSchema,
  EvidenceFileMetadataSchema,
  type TransactionResponse,
} from '@resolve-ai/contracts';
import type {
  EvidenceDossier,
  EvidenceItem,
} from '../../generated/prisma/client.js';
import { contentHash } from '../../common/data/content-hash.js';
import { paymentRecord, type EvidenceContext } from './evidence-context.js';

export type StoredDossier = EvidenceDossier & { items: EvidenceItem[] };
export function currentEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const latest = new Map<string, EvidenceItem>();
  for (const item of items) {
    if ((latest.get(item.logicalKey)?.version ?? 0) < item.version)
      latest.set(item.logicalKey, item);
  }
  return [...latest.values()];
}

export function evaluateEvidence(
  context: EvidenceContext,
  dossier: StoredDossier | null,
): TransactionResponse['readiness'] {
  const current = currentEvidence(dossier?.items ?? []);
  const reasons: string[] = [];
  let invalidDocument = false;
  const checks: TransactionResponse['readiness']['checks'] = [
    { code: 'PAYMENT_RECORD', status: 'PRESENT', evidenceIds: [] },
    {
      code: 'ORDER_REFERENCE',
      status:
        context.paypalOrderId || context.merchantOrderReference
          ? 'PRESENT'
          : 'MISSING',
      evidenceIds: [],
    },
    { code: 'ORDER_RECORD', status: 'MISSING', evidenceIds: [] },
    { code: 'TRACKING', status: 'MISSING', evidenceIds: [] },
    { code: 'PROOF_OF_DELIVERY', status: 'MISSING', evidenceIds: [] },
  ];
  const check = (code: string) => checks.find((c) => c.code === code)!;
  const conflict = (code: string, reason: string) => {
    check(code).status = 'CONFLICT';
    reasons.push(reason);
  };
  if (context.orderLinkError) conflict('ORDER_RECORD', context.orderLinkError);
  const tracking: Array<{
    item: EvidenceItem;
    data: ReturnType<typeof TrackingContentSchema.parse>;
  }> = [];
  const deliveries: Array<{
    item: EvidenceItem;
    data: ReturnType<typeof DeliveryContentSchema.parse>;
  }> = [];
  for (const item of current) {
    if (item.type === 'ORDER_SOURCE_RECORD') {
      if (item.contentHash !== contentHash(item.content))
        conflict('ORDER_RECORD', 'EVIDENCE_INTEGRITY_MISMATCH');
      continue;
    }
    if (item.type === 'DOCUMENT') {
      if (
        item.contentHash !== contentHash(item.content) ||
        !EvidenceFileMetadataSchema.safeParse(item.content).success
      ) {
        invalidDocument = true;
        reasons.push('EVIDENCE_FILE_METADATA_INVALID');
      }
      continue;
    }
    const code = item.type === 'ORDER_RECORD' ? 'ORDER_RECORD' : item.type;
    const target = checks.find((c) => c.code === code);
    if (!target) continue;
    target.evidenceIds.push(item.id);
    if (item.contentHash !== contentHash(item.content)) {
      conflict(code, 'EVIDENCE_INTEGRITY_MISMATCH');
      continue;
    }
    if (item.type === 'PAYMENT_RECORD') {
      if (item.contentHash !== contentHash(paymentRecord(context)))
        conflict(code, 'PAYMENT_RECORD_MISMATCH');
      continue;
    }
    if (item.type === 'ORDER_RECORD') {
      if (
        !(context.orders ?? (context.order ? [context.order] : [])).some(
          (order) => item.contentHash === contentHash(order),
        )
      )
        conflict(code, 'ORDER_RECORD_MISMATCH');
      else if (
        context.order &&
        context.orderRecordComplete !== false &&
        !context.orderLinkError &&
        target.status !== 'CONFLICT'
      )
        target.status = 'PRESENT';
      continue;
    }
    const parsed =
      item.type === 'TRACKING'
        ? TrackingContentSchema.safeParse(item.content)
        : DeliveryContentSchema.safeParse(item.content);
    if (!parsed.success) {
      conflict(code, 'EVIDENCE_CONTENT_INVALID');
      continue;
    }
    if (
      !context.order ||
      parsed.data.paypalCaptureId !== context.paypalCaptureId ||
      parsed.data.merchantOrderReference !== context.order.externalId
    ) {
      conflict(code, 'EVIDENCE_IDENTITY_MISMATCH');
      continue;
    }
    if (item.type === 'TRACKING') {
      const data = TrackingContentSchema.parse(parsed.data);
      tracking.push({ item, data });
      if (data.status === 'CANCELLED') {
        conflict(code, 'SHIPMENT_CANCELLED');
        continue;
      }
      if (
        context.order.orderedAt &&
        Date.parse(data.shippedAt) < Date.parse(context.order.orderedAt)
      ) {
        conflict(code, 'SHIPMENT_BEFORE_ORDER');
        continue;
      }
    } else {
      const data = DeliveryContentSchema.parse(parsed.data);
      deliveries.push({ item, data });
      if (data.status === 'RETRACTED') {
        reasons.push('DELIVERY_RETRACTED');
        continue;
      }
      if (
        context.order.orderedAt &&
        Date.parse(data.deliveredAt) < Date.parse(context.order.orderedAt)
      ) {
        conflict(code, 'DELIVERY_BEFORE_ORDER');
        continue;
      }
    }
    if (target.status !== 'CONFLICT') target.status = 'PRESENT';
  }
  // MVP: one parcel per order. Independent sources disagreeing on parcel identity require review.
  const identities = new Set(
    [...tracking, ...deliveries].map(
      ({ data }) => `${data.carrier.toUpperCase()}:${data.trackingNumber}`,
    ),
  );
  if (identities.size > 1) {
    conflict('TRACKING', 'TRACKING_CONTRADICTION');
    conflict('PROOF_OF_DELIVERY', 'TRACKING_CONTRADICTION');
  }
  for (const shipment of tracking)
    for (const delivery of deliveries) {
      if (
        delivery.data.status !== 'RETRACTED' &&
        Date.parse(delivery.data.deliveredAt) <
          Date.parse(shipment.data.shippedAt)
      )
        conflict('PROOF_OF_DELIVERY', 'DELIVERY_BEFORE_SHIPMENT');
    }
  if (deliveries.some((d) => d.data.status === 'RETRACTED'))
    check('PROOF_OF_DELIVERY').status =
      check('PROOF_OF_DELIVERY').status === 'CONFLICT' ? 'CONFLICT' : 'MISSING';
  const status =
    invalidDocument || checks.some((c) => c.status === 'CONFLICT')
      ? 'NEEDS_REVIEW'
      : checks.every((c) => c.status === 'PRESENT')
        ? 'READY'
        : 'INCOMPLETE';
  return {
    status,
    basis: 'DOCUMENT_COVERAGE',
    containsDemo:
      context.order?.sourceKind === 'DEMO' ||
      current.some((i) => i.sourceKind === 'DEMO'),
    dossierId: dossier?.id ?? null,
    evidenceRevision: dossier?.revision ?? 0,
    reasons: [...new Set(reasons)],
    checks,
  };
}
