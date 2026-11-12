import { z } from 'zod';
import {
  ShipmentObservationSchema,
  TrackingNumberSchema,
  type ShipmentObservation,
  type ShipmentEvent,
  type ShipmentStatus,
} from '@resolve-ai/contracts';
import { contentHash } from '../../common/data/content-hash.js';

export class TrackingProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly providerCode: number | null = null,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
export function iso(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !z.iso.datetime({ offset: true }).safeParse(value).success
  )
    return null;
  const time = Date.parse(value);
  return time <= Date.now() + 300000 ? new Date(time).toISOString() : null;
}
export function normalizeStatus(value: unknown): ShipmentStatus {
  const key = String(value ?? '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();
  const statuses: Record<string, ShipmentStatus> = {
    notreceived: 'UNKNOWN',
    notfound: 'UNKNOWN',
    unknown: 'UNKNOWN',
    inforeceived: 'INFO_RECEIVED',
    shipped: 'IN_TRANSIT',
    intransit: 'IN_TRANSIT',
    availableforpickup: 'AVAILABLE_FOR_PICKUP',
    outfordelivery: 'OUT_FOR_DELIVERY',
    deliveryfailure: 'DELIVERY_FAILED',
    deliveryfailed: 'DELIVERY_FAILED',
    delivered: 'DELIVERED',
    exception: 'EXCEPTION',
    onhold: 'EXCEPTION',
    expired: 'EXPIRED',
    cancelled: 'CANCELLED',
    canceled: 'CANCELLED',
    returned: 'RETURNED',
  };
  return statuses[key] ?? 'UNKNOWN';
}
export function sortedEvents(events: ShipmentEvent[]) {
  return [...new Map(events.map((e) => [contentHash(e), e])).values()].sort(
    (a, b) => a.occurredAt.localeCompare(b.occurredAt),
  );
}
export function useful(
  observation: ShipmentObservation,
  freshHours: number,
  now = Date.now(),
) {
  return (
    !observation.containsDemo &&
    observation.status !== 'UNKNOWN' &&
    !observation.issues.length &&
    observation.events.length > 0 &&
    observation.updatedAt !== null &&
    ((observation.status === 'DELIVERED' && observation.deliveredAt !== null) ||
      now - Date.parse(observation.updatedAt) <= freshHours * 3600000)
  );
}
export function discrepancies(observations: ShipmentObservation[]) {
  const issues = new Set(observations.flatMap((o) => o.issues));
  for (const a of observations)
    for (const b of observations) {
      if (a === b || a.containsDemo || b.containsDemo) continue;
      // A later in-transit event after a delivered/cancelled event needs review.
      if (
        a.trackingNumber === b.trackingNumber &&
        a.status !== b.status &&
        ['DELIVERED', 'CANCELLED', 'RETURNED'].includes(a.status) &&
        b.status !== 'UNKNOWN' &&
        b.updatedAt &&
        a.updatedAt &&
        b.updatedAt >= a.updatedAt
      )
        issues.add(
          `SOURCE_STATUS_CONFLICT:${a.source}:${b.source}:${a.trackingNumber}`,
        );
      const carrierName = (name: string | null) =>
        name?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
      const ac = carrierName(a.carrier),
        bc = carrierName(b.carrier);
      if (
        a.trackingNumber === b.trackingNumber &&
        ac &&
        bc &&
        ac !== bc &&
        !['other', 'unknown'].includes(ac) &&
        !['other', 'unknown'].includes(bc) &&
        !(a.carrierCode && a.carrierCode === b.carrierCode)
      )
        issues.add(`CARRIER_NAME_CONFLICT:${a.trackingNumber}`);
      if (
        a.trackingNumber === b.trackingNumber &&
        a.carrierCode &&
        b.carrierCode &&
        a.carrierCode !== b.carrierCode
      )
        issues.add(`CARRIER_CONFLICT:${a.trackingNumber}`);
    }
  return [...issues];
}
const event17 = z
  .object({
    time_utc: z.string().nullish(),
    time_iso: z.string().nullish(),
    description: z.string().max(2000).nullish(),
    location: z.string().max(1000).nullish(),
    stage: z.string().nullish(),
    sub_status: z.string().nullish(),
  })
  .passthrough();
export const Tracking17ItemSchema = z
  .object({
    number: TrackingNumberSchema,
    carrier: z.number().int().nonnegative(),
    tag: z.string().nullish(),
    origin: z.number().int().optional(),
    track_info: z
      .object({
        latest_status: z.object({ status: z.string().nullish() }).nullish(),
        latest_event: event17.nullish(),
        milestone: z
          .array(
            z.object({
              key_stage: z.string(),
              time_utc: z.string().nullish(),
              time_iso: z.string().nullish(),
            }),
          )
          .max(100)
          .nullish(),
        tracking: z
          .object({
            providers: z
              .array(
                z
                  .object({
                    provider: z
                      .object({
                        key: z.number().int(),
                        name: z.string().max(255),
                      })
                      .passthrough(),
                    latest_sync_time: z.string().nullish(),
                    latest_sync_status: z.string().nullish(),
                    events: z.array(event17).max(2000).nullish(),
                  })
                  .passthrough(),
              )
              .max(20)
              .nullish(),
          })
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export function normalize17Track(
  raw: unknown,
  origin?: number | null,
): ShipmentObservation {
  const item = Tracking17ItemSchema.parse(raw);
  const info = item.track_info;
  const providers = info?.tracking?.providers ?? [];
  const carrier =
    providers.find((p) => p.provider.key === item.carrier)?.provider.name ??
    providers[0]?.provider.name ??
    null;
  const events = sortedEvents([
    ...providers.flatMap((p) =>
      (p.events ?? []).flatMap((e) => {
        const occurredAt = iso(e.time_utc) ?? iso(e.time_iso);
        return occurredAt
          ? [
              {
                occurredAt,
                status: normalizeStatus(e.stage ?? e.sub_status),
                description: e.description ?? '',
                location: e.location ?? null,
                carrier: p.provider.name,
              },
            ]
          : [];
      }),
    ),
    ...[info?.latest_event].flatMap((e) => {
      const occurredAt = iso(e?.time_utc) ?? iso(e?.time_iso);
      return e && occurredAt
        ? [
            {
              occurredAt,
              status: normalizeStatus(e.stage ?? e.sub_status),
              description: e.description ?? '',
              location: e.location ?? null,
              carrier,
            },
          ]
        : [];
    }),
  ]);
  const status = normalizeStatus(info?.latest_status?.status);
  const delivered = (info?.milestone ?? []).find(
    (m) => m.key_stage === 'Delivered',
  );
  const deliveredAt =
    status === 'DELIVERED'
      ? (iso(delivered?.time_utc) ??
        iso(delivered?.time_iso) ??
        events.filter((e) => e.status === 'DELIVERED').at(-1)?.occurredAt ??
        null)
      : null;
  const issues: string[] = [];
  if (origin === 3) issues.push('CARRIER_AUTO_DETECTION_UNCERTAIN');
  if (
    providers.length &&
    providers.every((p) => p.latest_sync_status !== 'Success')
  )
    issues.push('CARRIER_SYNC_UNSUCCESSFUL');
  return ShipmentObservationSchema.parse({
    source: '17track',
    sourceSystem: '17track:v2.4',
    trackingNumber: item.number,
    carrier,
    carrierCode: item.carrier || null,
    status,
    updatedAt: events.at(-1)?.occurredAt ?? null,
    deliveredAt,
    deliveryReported: status === 'DELIVERED',
    documentaryProof: false,
    events,
    issues,
  });
}

// Public normalized ERP shipment contract. These are internal fields, not 17TRACK fields.
export const ErpShipmentSchema = z.object({
  trackingNumber: TrackingNumberSchema,
  carrier: z.string().max(255).nullish(),
  carrierCode: z.number().int().positive().max(2147483647).nullish(),
  status: z.string().max(100).optional(),
  updatedAt: z.string().optional(),
  deliveredAt: z.string().nullish(),
  events: z
    .array(
      z.object({
        occurredAt: z.string(),
        status: z.string(),
        description: z.string().max(2000),
        location: z.string().max(1000).nullish(),
      }),
    )
    .max(2000)
    .optional(),
});
export function normalizeErp(
  raw: unknown,
  sourceSystem: string,
  containsDemo: boolean,
): ShipmentObservation | null {
  const parsed = ErpShipmentSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const events = sortedEvents(
    (item.events ?? []).flatMap((e) => {
      const occurredAt = iso(e.occurredAt);
      return occurredAt
        ? [
            {
              ...e,
              occurredAt,
              status: normalizeStatus(e.status),
              location: e.location ?? null,
              carrier: item.carrier ?? null,
            },
          ]
        : [];
    }),
  );
  const status = normalizeStatus(item.status ?? events.at(-1)?.status);
  return ShipmentObservationSchema.parse({
    source: 'erp',
    sourceSystem,
    trackingNumber: item.trackingNumber,
    carrier: item.carrier ?? null,
    carrierCode: item.carrierCode ?? null,
    status,
    updatedAt: events.at(-1)?.occurredAt ?? iso(item.updatedAt),
    deliveredAt:
      status === 'DELIVERED'
        ? (iso(item.deliveredAt) ??
          events.filter((e) => e.status === 'DELIVERED').at(-1)?.occurredAt ??
          null)
        : null,
    deliveryReported: status === 'DELIVERED',
    documentaryProof: false,
    containsDemo,
    events,
    issues: [],
  });
}
