import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  WebhookReceiptSchema,
  type WebhookReceipt,
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
    const context = await this.merchants.getPayPalWebhookContext();
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
    const kind = ingestionJobKind(event.event_type);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const stored = await tx.webhookEvent.create({
          data: {
            merchantId: context.merchantId,
            environment: 'sandbox',
            paypalEventId: event.id,
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
}
