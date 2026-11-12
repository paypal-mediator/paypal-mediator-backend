import { z } from 'zod';

export const TrackingNumberSchema = z
  .string()
  .trim()
  .min(5)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const ShipmentStatusSchema = z.enum([
  'UNKNOWN',
  'INFO_RECEIVED',
  'IN_TRANSIT',
  'AVAILABLE_FOR_PICKUP',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
  'DELIVERED',
  'EXCEPTION',
  'EXPIRED',
  'CANCELLED',
  'RETURNED',
]);
export const ShipmentEventSchema = z.object({
  occurredAt: z.iso.datetime(),
  status: ShipmentStatusSchema,
  description: z.string().max(2000),
  location: z.string().max(1000).nullable(),
  carrier: z.string().max(255).nullable(),
});
export const ShipmentObservationSchema = z.object({
  source: z.enum(['paypal', 'erp', '17track']),
  sourceSystem: z.string().max(255),
  trackingNumber: TrackingNumberSchema,
  carrier: z.string().max(255).nullable(),
  carrierCode: z.number().int().positive().nullable(),
  status: ShipmentStatusSchema,
  updatedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  deliveryReported: z.boolean(),
  documentaryProof: z.literal(false),
  containsDemo: z.boolean().default(false),
  events: z.array(ShipmentEventSchema).max(2000),
  issues: z.array(z.string()).max(50),
});
export type ShipmentObservation = z.infer<typeof ShipmentObservationSchema>;
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;
export type ShipmentEvent = z.infer<typeof ShipmentEventSchema>;
export const ResolveShipmentTrackingSchema = z.strictObject({
  retryFailed: z.boolean().optional(),
  trackingNumber: TrackingNumberSchema.optional(),
  carrierCode: z.number().int().positive().max(2147483647).optional(),
  destinationPostalCode: z.string().trim().min(1).max(32).optional(),
  originCountry: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  shipDate: z
    .string()
    .regex(/^\d{4}\/\d{2}\/\d{2}$/)
    .optional(),
});
export type ResolveShipmentTracking = z.infer<
  typeof ResolveShipmentTrackingSchema
>;
export const TrackingSourceAttemptSchema = z.object({
  source: z.enum(['paypal', 'erp', '17track']),
  state: z.enum([
    'AVAILABLE',
    'ABSENT',
    'STALE',
    'TEMPORARY_ERROR',
    'PERMANENT_ERROR',
    'NOT_CONFIGURED',
    'CONTRADICTORY',
    'CACHED',
  ]),
  errorCode: z.string().nullable(),
  providerCode: z.number().int().nullable(),
});
export type TrackingSourceAttempt = z.infer<typeof TrackingSourceAttemptSchema>;
export const ShipmentTrackingResponseSchema = z.object({
  transactionId: z.uuid(),
  orderId: z.string().nullable(),
  disputeIds: z.array(z.uuid()),
  state: z.enum([
    'PENDING',
    'SYNCING',
    'CURRENT',
    'STALE',
    'NO_DATA',
    'NO_TRACKING_NUMBER',
    'NEEDS_REVIEW',
    'FAILED',
    'NOT_CONFIGURED',
  ]),
  selected: ShipmentObservationSchema.nullable(),
  observations: z.array(ShipmentObservationSchema),
  discrepancies: z.array(z.string()),
  attempts: z.array(TrackingSourceAttemptSchema),
  lastAttemptAt: z.iso.datetime().nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
  errorCode: z.string().nullable(),
});
export type ShipmentTrackingResponse = z.infer<
  typeof ShipmentTrackingResponseSchema
>;
