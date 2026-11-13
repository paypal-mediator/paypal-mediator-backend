import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  WebhookReceiptSchema,
  type WebhookReceipt,
  type PayPalWebhookEnvelope,
  paypalRefundCaptureId,
} from '@resolve-ai/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import { MerchantsService } from '../merchants/index.js';
import { AuditService } from '../monitoring/audit.service.js';
import { PayPalWebhookVerifier } from './paypal-webhook.verifier.js';
import {
  ingestionJobKind,
  parseTransmissionHeaders,
  parseWebhookBody,
  webhookHashes,
} from './webhook-validation.js';

@Injectable()
export class EventIngestionService {
  private readonly logger = new Logger(EventIngestionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MerchantsService) private readonly merchants: MerchantsService,
    @Inject(PayPalWebhookVerifier)
    private readonly verifier: PayPalWebhookVerifier,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async receive(
    rawBody: Buffer | undefined,
    httpHeaders: Record<string, string | string[] | undefined>,
  ): Promise<WebhookReceipt> {
    const headers = parseTransmissionHeaders(httpHeaders);
    const event = parseWebhookBody(rawBody);
    // parseWebhookBody guarantees the buffer exists; hashes precede any external call.
    const originalBody = rawBody!;
    const hashes = webhookHashes(event, originalBody);
    const context = await this.webhookContext(event);
    try {
      await this.verifier.verify(event, headers, context.webhookId);
    } catch (error) {
      await this.audit.append({
        merchantId: context.merchantId,
        actorUserId: null,
        actorKind: 'PAYPAL',
        resourceType: 'WEBHOOK',
        outcome: 'BLOCKED',
        record: {
          action: 'WEBHOOK_REJECTED',
          details: { errorCode: 'WEBHOOK_VERIFICATION_FAILED' },
        },
      });
      throw error;
    }
    if (event.event_type === 'MERCHANT.PARTNER-CONSENT.REVOKED')
      await this.merchants.revokePayPal(context.merchantId);
    const kind = ingestionJobKind(event.event_type);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const stored = await tx.webhookEvent.create({
          data: {
            merchantId: context.merchantId,
            environment: 'sandbox',
            paypalEventId: event.id,
            paypalResourceId:
              typeof event.resource.id === 'string' &&
              event.resource.id.length <= 255
                ? event.resource.id
                : null,
            eventType: event.event_type,
            eventCreatedAt: new Date(event.create_time),
            webhookId: context.webhookId,
            transmissionId: headers.transmission_id,
            payload: event as Prisma.InputJsonValue,
            rawBody: originalBody.toString('utf8'),
            ...hashes,
          },
        });
        const job = kind
          ? await tx.ingestionJob.create({ data: { eventId: stored.id, kind } })
          : null;
        await this.audit.append(
          {
            merchantId: context.merchantId,
            actorUserId: null,
            actorKind: 'PAYPAL',
            resourceType: 'WEBHOOK',
            resourceId: stored.id,
            outcome: kind ? 'SUCCEEDED' : 'IGNORED',
            record: {
              action: 'WEBHOOK_RECEIVED',
              details: { state: kind ? 'QUEUED' : 'IGNORED' },
            },
          },
          tx,
        );
        return WebhookReceiptSchema.parse({
          eventId: stored.id,
          paypalEventId: event.id,
          outcome: kind ? 'ACCEPTED' : 'IGNORED',
          jobId: job?.id ?? null,
        });
      });
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'P2002'
      )
        throw error;
      // A concurrent duplicate is visible only after the original transaction commits.
      const existing = await this.prisma.webhookEvent.findUnique({
        where: {
          merchantId_environment_paypalEventId: {
            merchantId: context.merchantId,
            environment: 'sandbox',
            paypalEventId: event.id,
          },
        },
        include: { job: true },
      });
      if (!existing) throw error;
      if (existing.payloadHash !== hashes.payloadHash) {
        await this.audit.append({
          merchantId: context.merchantId,
          actorUserId: null,
          actorKind: 'PAYPAL',
          resourceType: 'WEBHOOK',
          resourceId: existing.id,
          outcome: 'BLOCKED',
          record: {
            action: 'WEBHOOK_REJECTED',
            details: { errorCode: 'WEBHOOK_EVENT_CONFLICT' },
          },
        });
        throw new ApiException(
          'WEBHOOK_EVENT_CONFLICT',
          'This PayPal event ID was received with different content',
          409,
        );
      }
      await this.audit.append({
        merchantId: context.merchantId,
        actorUserId: null,
        actorKind: 'PAYPAL',
        resourceType: 'WEBHOOK',
        resourceId: existing.id,
        outcome: 'DUPLICATE',
        record: { action: 'WEBHOOK_DUPLICATE', details: {} },
      });
      return WebhookReceiptSchema.parse({
        eventId: existing.id,
        paypalEventId: event.id,
        outcome: 'DUPLICATE',
        jobId: existing.job?.id ?? null,
      });
    }
  }

  private async webhookContext(event: PayPalWebhookEnvelope) {
    if (ingestionJobKind(event.event_type) !== 'PAYMENT_ADJUSTED')
      return this.merchants.getPayPalWebhookContext(
        event.resource,
        event.event_type,
      );
    const captureId = paypalRefundCaptureId(event.resource);
    if (!captureId)
      throw new ApiException(
        'INVALID_REFUND_CAPTURE_REFERENCE',
        'Refund must identify exactly one Sandbox capture',
        422,
      );
    // M02 reads only its own verified envelopes. No fallback to an arbitrary team.
    const origins = await this.prisma.webhookEvent.findMany({
      where: {
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        paypalResourceId: captureId,
        environment: 'sandbox',
      },
      distinct: ['merchantId'],
      take: 2,
      select: { merchantId: true, payload: true },
    });
    if (origins.length > 1)
      throw new ApiException(
        'PAYPAL_WEBHOOK_MERCHANT_UNKNOWN',
        'Capture ownership is ambiguous',
        422,
      );
    const hasIdentity = ['merchant_id', 'payee', 'disputed_transactions'].some(
      (key) => key in event.resource,
    );
    if (!hasIdentity && origins[0]) {
      const original = origins[0].payload as {
        resource: Record<string, unknown>;
      };
      return this.merchants.getPayPalWebhookContext(
        original.resource,
        event.event_type,
      );
    }
    try {
      const context = await this.merchants.getPayPalWebhookContext(
        event.resource,
        event.event_type,
      );
      if (origins[0] && context.merchantId !== origins[0].merchantId)
        throw new ApiException(
          'PAYPAL_WEBHOOK_MERCHANT_UNKNOWN',
          'Refund seller does not own this capture',
          422,
        );
      return context;
    } catch (error) {
      if (
        !hasIdentity &&
        !origins.length &&
        error instanceof ApiException &&
        error.code === 'PAYPAL_WEBHOOK_MERCHANT_UNKNOWN'
      )
        throw new ApiException(
          'PAYPAL_CAPTURE_ROUTING_PENDING',
          'Original capture delivery is required before routing this refund; retry delivery',
          503,
        );
      throw error;
    }
  }
}
