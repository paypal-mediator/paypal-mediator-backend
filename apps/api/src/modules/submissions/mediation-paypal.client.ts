import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { ApiException } from '../../common/http/api.exception.js';
import { MAX_EVIDENCE_FILE_BYTES } from '@resolve-ai/contracts';
import {
  assertEvidenceFileFormat,
  assertEvidenceFileSafety,
} from '../evidence/evidence-file-safety.js';
import { contentHash } from '../../common/data/content-hash.js';
import { binaryHash } from '../evidence/evidence-storage.js';
import {
  PAYPAL_FETCH,
  PAYPAL_SANDBOX_URL,
  PayPalAuthService,
} from '../merchants/index.js';

export const PayPalMediationDetailSchema = z.object({
  dispute_id: z.string().regex(/^[A-Za-z0-9-]{1,255}$/),
  create_time: z.iso.datetime({ offset: true }),
  status: z.string().min(1).max(64),
  dispute_life_cycle_stage: z.string().min(1).max(64),
  reason: z.string().max(128).optional(),
  seller_response_due_date: z.iso.datetime({ offset: true }).optional(),
  disputed_transactions: z
    .array(z.object({ seller_transaction_id: z.string().min(1).max(255) }))
    .min(1)
    .max(64),
  messages: z
    .array(
      z.object({
        posted_by: z.enum(['BUYER', 'SELLER', 'ARBITER']),
        time_posted: z.iso.datetime({ offset: true }),
        content: z.string().max(2000),
        documents: z.array(z.unknown()).max(32).optional(),
      }),
    )
    .max(256)
    .default([]),
  evidences: z
    .array(
      z
        .object({
          evidence_type: z.string().max(255),
          source: z.string().max(128).optional(),
          notes: z.string().max(10000).optional(),
          documents: z.array(z.unknown()).max(32).optional(),
        })
        .passthrough(),
    )
    .max(256)
    .default([]),
  supporting_info: z
    .array(
      z
        .object({
          source: z.string().max(128).optional(),
          notes: z.string().max(10000).optional(),
          documents: z.array(z.unknown()).max(32).optional(),
        })
        .passthrough(),
    )
    .max(256)
    .default([]),
  links: z
    .array(
      z.object({
        rel: z.string().max(128),
        href: z.url(),
        method: z.string().max(16).optional(),
      }),
    )
    .max(64),
});
export type PayPalMediationDetail = z.infer<typeof PayPalMediationDetailSchema>;
export type MediationPayPalAction =
  'send-message' | 'provide-evidence' | 'escalate' | 'provide-supporting-info';

@Injectable()
export class MediationPayPalClient {
  async document(merchantId: string, disputeId: string, reference: string) {
    const merchantHeaders = await this.auth.merchantHeaders(merchantId);
    try {
      const url = new URL(reference);
      if (
        ![
          'https://api-m.sandbox.paypal.com',
          'https://api.sandbox.paypal.com',
        ].includes(url.origin) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith(
          `/v1/customer/disputes/${disputeId}/documents/`,
        ) ||
        /%2f|%2e|%5c/i.test(url.pathname)
      )
        throw new Error();
      this.path(disputeId);
      const signal = AbortSignal.timeout(this.env.PAYPAL_TIMEOUT_MS),
        token = await this.auth.getAccessToken(signal);
      const response = await this.fetcher(url.href, {
        redirect: 'error',
        signal,
        headers: {
          ...merchantHeaders,
          Authorization: `Bearer ${token.accessToken}`,
        },
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_EVIDENCE_FILE_BYTES) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      const mediaType =
        response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      assertEvidenceFileFormat(bytes, mediaType);
      assertEvidenceFileSafety(bytes, mediaType);
      return {
        bytes,
        mediaType,
        reference,
        sha256: binaryHash(bytes),
        id: `paypal-file:${contentHash(reference)}`,
      };
    } catch {
      throw new ApiException(
        'MEDIATION_PAYPAL_DOCUMENT_REVIEW',
        'PayPal document originals could not be securely retrieved or inspected',
        409,
      );
    }
  }
  async documents(merchantId: string, detail: PayPalMediationDetail) {
    try {
      const references = [
        ...detail.messages.flatMap((m) => m.documents ?? []),
        ...detail.evidences.flatMap((e) => e.documents ?? []),
        ...detail.supporting_info.flatMap((e) => e.documents ?? []),
      ];
      const parsed = z
        .array(z.object({ url: z.url() }))
        .max(512)
        .parse(references);
      const unique = [...new Set(parsed.map((d) => d.url))];
      if (unique.length > 9) throw new Error();
      const files: Awaited<ReturnType<MediationPayPalClient['document']>>[] =
        [];
      for (const reference of unique)
        files.push(
          await this.document(merchantId, detail.dispute_id, reference),
        );
      return files;
    } catch {
      throw new ApiException(
        'MEDIATION_PAYPAL_DOCUMENT_REVIEW',
        'PayPal document originals require authorized inspection',
        409,
      );
    }
  }
  constructor(
    @Inject(PAYPAL_FETCH) private readonly fetcher: typeof fetch,
    @Inject(PayPalAuthService) private readonly auth: PayPalAuthService,
    @Inject(ENVIRONMENT) private readonly env: Environment,
  ) {}
  private path(id: string, action?: MediationPayPalAction) {
    if (!/^[A-Za-z0-9-]{1,255}$/.test(id))
      throw new ApiException(
        'PAYPAL_INVALID_DISPUTE',
        'Invalid PayPal dispute identifier',
        422,
      );
    if (
      action &&
      ![
        'send-message',
        'provide-evidence',
        'escalate',
        'provide-supporting-info',
      ].includes(action)
    )
      throw new ApiException(
        'PAYPAL_FORBIDDEN_OPERATION',
        'Financial operations are forbidden',
        422,
      );
    return `${PAYPAL_SANDBOX_URL}/v1/customer/disputes/${id}${action ? `/${action}` : ''}`;
  }
  async detail(merchantId: string, id: string) {
    const merchantHeaders = await this.auth.merchantHeaders(merchantId);
    const signal = AbortSignal.timeout(this.env.PAYPAL_TIMEOUT_MS);
    try {
      const token = await this.auth.getAccessToken(signal);
      const response = await this.fetcher(this.path(id), {
        headers: {
          ...merchantHeaders,
          Authorization: `Bearer ${token.accessToken}`,
        },
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 512 * 1024) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
      const detail = PayPalMediationDetailSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (detail.dispute_id !== id) throw new Error();
      return detail;
    } catch {
      throw new ApiException(
        'PAYPAL_DISPUTE_UNAVAILABLE',
        'Unable to retrieve a verified PayPal dispute',
        502,
      );
    }
  }
  can(detail: PayPalMediationDetail, action: MediationPayPalAction) {
    if (
      (action === 'send-message' || action === 'escalate') &&
      detail.dispute_life_cycle_stage !== 'INQUIRY'
    )
      return false;
    if (
      action === 'provide-supporting-info' &&
      !['CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'].includes(
        detail.dispute_life_cycle_stage,
      )
    )
      return false;
    return (
      detail.status !== 'RESOLVED' &&
      detail.links.some(
        (l) =>
          l.rel === action &&
          l.method === 'POST' &&
          l.href === this.path(detail.dispute_id, action),
      )
    );
  }
  async perform(
    merchantId: string,
    detail: PayPalMediationDetail,
    action: MediationPayPalAction,
    body: Record<string, unknown> | FormData,
    key: string,
  ) {
    const merchantHeaders = await this.auth.merchantHeaders(merchantId);
    this.path(detail.dispute_id, action);
    if (
      detail.seller_response_due_date &&
      new Date(detail.seller_response_due_date) <= new Date()
    )
      throw new ApiException(
        'PAYPAL_DEADLINE_EXPIRED',
        'The PayPal response deadline expired',
        409,
      );
    if (!this.can(detail, action))
      throw new ApiException(
        'PAYPAL_ACTION_UNAVAILABLE',
        'PayPal does not currently permit this operation',
        409,
      );
    const signal = AbortSignal.timeout(this.env.PAYPAL_TIMEOUT_MS);
    const token = await this.auth.getAccessToken(signal);
    // No automatic retry: PayPal does not document idempotency for every action.
    // A timeout after dispatch is ambiguous and must be reconciled from PayPal.
    const response = await this.fetcher(this.path(detail.dispute_id, action), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        ...merchantHeaders,
        Authorization: `Bearer ${token.accessToken}`,
        'PayPal-Request-Id': key,
        ...(body instanceof FormData
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    await response.body?.cancel();
    if (response.status !== 200)
      throw new ApiException(
        'PAYPAL_DELIVERY_REJECTED',
        'PayPal did not acknowledge delivery',
        502,
      );
  }
}
