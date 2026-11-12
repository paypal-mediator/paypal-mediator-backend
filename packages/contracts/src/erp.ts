import { z } from 'zod';
import { CommerceReferenceSchema } from './orders.js';

export const ErpProviderSchema = z.enum([
  'bind',
  'siigo-mx',
  'odoo',
  'erpnext',
  'business-central',
  'netsuite',
  'quickbooks',
  'xero',
  'zoho-books',
  'mock-erp',
]);
export type ErpProvider = z.infer<typeof ErpProviderSchema>;

export const ErpCapabilitySchema = z.enum([
  'customers',
  'sales_orders',
  'invoices',
  'payments',
  'refunds',
  'shipments',
  'documents',
]);
export type ErpCapability = z.infer<typeof ErpCapabilitySchema>;

export const ErpConnectionStatusSchema = z.enum([
  'pending_authorization',
  'connected',
  'syncing',
  'restricted_permissions',
  'needs_reauth',
  'rate_limited',
  'error',
  'disconnected',
]);
export type ErpConnectionStatus = z.infer<typeof ErpConnectionStatusSchema>;

export const MatchMethodSchema = z.enum([
  'invoice_id_exact',
  'custom_id_exact',
  'corroborated',
  'suggested',
]);
export type MatchMethod = z.infer<typeof MatchMethodSchema>;

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ErpConnectionSchema = z.strictObject({
  id: z.uuid(),
  merchantId: z.uuid(),
  provider: ErpProviderSchema,
  externalTenantId: z.string().nullable(),
  baseUrl: z.string().url().nullable(),
  status: ErpConnectionStatusSchema,
  scopes: z.string().nullable(),
  lastSyncAt: z.string().datetime().nullable(),
  lastSyncError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ErpConnection = z.infer<typeof ErpConnectionSchema>;

export const ErpConnectionListResponseSchema = z.object({
  items: z.array(ErpConnectionSchema),
  total: z.number().int(),
});
export type ErpConnectionListResponse = z.infer<
  typeof ErpConnectionListResponseSchema
>;

export const StartErpConnectionSchema = z.strictObject({
  provider: ErpProviderSchema,
});
export type StartErpConnection = z.infer<typeof StartErpConnectionSchema>;

export const ConnectErpWithKeySchema = z.strictObject({
  provider: ErpProviderSchema,
  apiKey: CommerceReferenceSchema,
  baseUrl: z.string().url().optional(),
  database: z.string().trim().min(1).max(255).optional(),
});
export type ConnectErpWithKey = z.infer<typeof ConnectErpWithKeySchema>;

export const ErpConnectionStatusResponseSchema = z.strictObject({
  connectionId: z.uuid(),
  provider: ErpProviderSchema,
  status: ErpConnectionStatusSchema,
  externalTenantId: z.string().nullable(),
  capabilities: z.array(ErpCapabilitySchema),
  lastSyncAt: z.string().datetime().nullable(),
  lastSyncError: z.string().nullable(),
});
export type ErpConnectionStatusResponse = z.infer<
  typeof ErpConnectionStatusResponseSchema
>;

export const ErpSyncTriggerSchema = z.strictObject({
  connectionId: z.uuid(),
  resource: z
    .enum([
      'customers',
      'sales_orders',
      'invoices',
      'payments',
      'shipments',
      'documents',
    ])
    .optional(),
});
export type ErpSyncTrigger = z.infer<typeof ErpSyncTriggerSchema>;

export const ExternalRecordSchema = z.strictObject({
  id: z.uuid(),
  merchantId: z.uuid(),
  connectionId: z.uuid(),
  recordType: z.string(),
  externalId: CommerceReferenceSchema,
  updatedAt: z.string().datetime(),
  normalizedPayload: z.record(z.string(), z.unknown()),
  sourceHash: z.string(),
  createdAt: z.string().datetime(),
});
export type ExternalRecord = z.infer<typeof ExternalRecordSchema>;

export const ExternalRecordListResponseSchema = z.object({
  items: z.array(ExternalRecordSchema),
  total: z.number().int(),
});
export type ExternalRecordListResponse = z.infer<
  typeof ExternalRecordListResponseSchema
>;

export const TransactionLinkSchema = z.strictObject({
  id: z.uuid(),
  merchantId: z.uuid(),
  paypalCaptureId: CommerceReferenceSchema,
  paypalOrderId: CommerceReferenceSchema.nullable(),
  recordId: z.uuid(),
  matchMethod: MatchMethodSchema,
  confidence: ConfidenceSchema,
  reviewedBy: z.uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type TransactionLink = z.infer<typeof TransactionLinkSchema>;

export const TransactionLinkListResponseSchema = z.object({
  items: z.array(TransactionLinkSchema),
  total: z.number().int(),
});
export type TransactionLinkListResponse = z.infer<
  typeof TransactionLinkListResponseSchema
>;

export const ErpCatalogEntrySchema = z.strictObject({
  provider: ErpProviderSchema,
  name: z.string(),
  segment: z.string(),
  integrationType: z.enum(['oauth', 'api_key', 'local_agent']),
  connectionExperience: z.string(),
  capabilities: z.array(ErpCapabilitySchema),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  authUrl: z.string().url().optional(),
});
export type ErpCatalogEntry = z.infer<typeof ErpCatalogEntrySchema>;

export const ErpCatalogResponseSchema = z.object({
  items: z.array(ErpCatalogEntrySchema),
});
export type ErpCatalogResponse = z.infer<typeof ErpCatalogResponseSchema>;

export const ErpSyncJobPayloadSchema = z.strictObject({
  connectionId: z.uuid(),
  merchantId: z.uuid(),
  provider: ErpProviderSchema,
  resource: z.enum([
    'customers',
    'sales_orders',
    'invoices',
    'payments',
    'shipments',
    'documents',
  ]),
  cursor: z.string().nullable(),
});
export type ErpSyncJobPayload = z.infer<typeof ErpSyncJobPayloadSchema>;
