import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PayPalWebhookEnvelopeSchema,
  type PayPalWebhookEnvelope,
  type IngestionJobKind,
} from '@resolve-ai/contracts';
import { ApiException } from '../../common/http/api.exception.js';

const CertificateUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      [
        'api.paypal.com',
        'api-m.paypal.com',
        'api.sandbox.paypal.com',
        'api-m.sandbox.paypal.com',
      ].includes(url.hostname) &&
      /^\/v1\/notifications\/certs\/[A-Za-z0-9_-]+$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
});

export const TransmissionHeadersSchema = z.object({
  transmission_id: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_-]+$/),
  transmission_time: z.iso.datetime({ offset: true }),
  transmission_sig: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  cert_url: CertificateUrlSchema,
  auth_algo: z.literal('SHA256withRSA'),
});
export type TransmissionHeaders = z.infer<typeof TransmissionHeadersSchema>;

export function parseTransmissionHeaders(
  headers: Record<string, string | string[] | undefined>,
): TransmissionHeaders {
  const parsed = TransmissionHeadersSchema.safeParse({
    transmission_id: headers['paypal-transmission-id'],
    transmission_time: headers['paypal-transmission-time'],
    transmission_sig: headers['paypal-transmission-sig'],
    cert_url: headers['paypal-cert-url'],
    auth_algo: headers['paypal-auth-algo'],
  });
  if (!parsed.success)
    throw new ApiException(
      'INVALID_WEBHOOK_HEADERS',
      'Valid PayPal transmission headers are required',
      400,
    );
  return parsed.data;
}

export function parseWebhookBody(
  rawBody: Buffer | undefined,
): PayPalWebhookEnvelope {
  if (!rawBody?.length)
    throw new ApiException(
      'INVALID_WEBHOOK_BODY',
      'The original webhook JSON body is required',
      400,
    );
  try {
    const original: unknown = JSON.parse(rawBody.toString('utf8'));
    const parsed = PayPalWebhookEnvelopeSchema.safeParse(original);
    // Zod rebuilds objects in schema-key order. PayPal's signature postback
    // must receive the original event ordering, including unknown fields.
    if (parsed.success) return original as PayPalWebhookEnvelope;
  } catch {
    /* Normalize parse errors without returning submitted data. */
  }
  throw new ApiException(
    'INVALID_WEBHOOK_BODY',
    'A valid PayPal event envelope is required',
    400,
  );
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32)
    throw new ApiException(
      'INVALID_WEBHOOK_BODY',
      'Webhook nesting exceeds the supported limit',
      400,
    );
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function webhookHashes(event: PayPalWebhookEnvelope, rawBody: Buffer) {
  return {
    payloadHash: createHash('sha256')
      .update(canonicalJson(event))
      .digest('hex'),
    rawBodyHash: createHash('sha256').update(rawBody).digest('hex'),
  };
}

export function ingestionJobKind(eventType: string): IngestionJobKind | null {
  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') return 'TRANSACTION_CAPTURED';
  if (
    [
      'CUSTOMER.DISPUTE.CREATED',
      'CUSTOMER.DISPUTE.UPDATED',
      'CUSTOMER.DISPUTE.RESOLVED',
    ].includes(eventType)
  )
    return 'DISPUTE_CHANGED';
  return null;
}
