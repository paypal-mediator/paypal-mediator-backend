import { Inject, Injectable } from '@nestjs/common';
import {
  TransactionResponseSchema,
  type TransactionQuery,
  type TransactionResponse,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  RegisterEvidence,
  UploadEvidenceFile,
} from '@resolve-ai/contracts';
import type { MerchantActor } from '../merchants/index.js';
import { EvidenceService } from '../evidence/index.js';
import { lockMerchantOrders, reconcileOrder } from './order-linking.js';
import {
  evidenceContext,
  sourceEnrichment,
  type TransactionWithOrder,
} from './order-mapping.js';
import {
  IngestionQueueService,
  IngestionRejection,
} from '../event-ingestion/index.js';
import { parseCapture } from './capture.js';
import { OrderSourcesService } from './sources/order-sources.service.js';
import { AuditService } from '../monitoring/audit.service.js';

function response(
  row: TransactionWithOrder,
  readiness: TransactionResponse['readiness'],
): TransactionResponse {
  return TransactionResponseSchema.parse({
    ...row,
    amount: { currencyCode: row.currencyCode, value: row.amount.toFixed() },
    capturedAt: row.capturedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    order: evidenceContext(row).order,
    orderEnrichment: sourceEnrichment(row),
    orderLink: {
      status: evidenceContext(row).orderLinkError
        ? 'CONFLICT'
        : evidenceContext(row).order
          ? 'LINKED'
          : 'UNLINKED',
      reason:
        evidenceContext(row).orderLinkError ??
        (evidenceContext(row).order ? null : 'ORDER_NOT_FOUND'),
    },
    readiness,
  });
}

@Injectable()
export class TransactionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IngestionQueueService)
    private readonly queue: IngestionQueueService,
    @Inject(EvidenceService) private readonly evidence: EvidenceService,
    @Inject(OrderSourcesService) private readonly sources: OrderSourcesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async processNextCapture(merchantId: string) {
    return this.queue.processNext(
      'TRANSACTION_CAPTURED',
      merchantId,
      async (delivery, tx) => {
        if (delivery.environment !== 'sandbox')
          throw new IngestionRejection('INVALID_CAPTURE');
        const capture = parseCapture(delivery.payload);
        // Also serialize distinct webhook IDs referring to the same capture.
        const key = `${delivery.merchantId}:sandbox:${capture.paypalCaptureId}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
        await lockMerchantOrders(tx, delivery.merchantId);
        const existing = await tx.transaction.findUnique({
          where: {
            merchantId_environment_paypalCaptureId: {
              merchantId: delivery.merchantId,
              environment: 'sandbox',
              paypalCaptureId: capture.paypalCaptureId,
            },
          },
        });
        if (existing) {
          if (
            !existing.amount.equals(new Prisma.Decimal(capture.amount)) ||
            existing.currencyCode !== capture.currencyCode ||
            existing.capturedAt.getTime() !== capture.capturedAt.getTime() ||
            existing.paypalOrderId !== capture.paypalOrderId ||
            existing.merchantOrderReference !==
              capture.merchantOrderReference ||
            existing.invoiceId !== capture.invoiceId
          )
            throw new IngestionRejection('CAPTURE_CONFLICT');
          const linked = await reconcileOrder(tx, existing);
          await this.evidence.syncBase(tx, evidenceContext(linked));
          await this.sources.schedule(tx, linked);
          return { transactionId: existing.id };
        }
        const created = await tx.transaction.create({
          data: {
            ...capture,
            merchantId: delivery.merchantId,
            environment: 'sandbox',
            sourceEventId: delivery.eventId,
          },
        });
        const linked = await reconcileOrder(tx, created);
        await this.audit.append(
          {
            merchantId: delivery.merchantId,
            actorUserId: null,
            actorKind: 'SYSTEM',
            transactionId: created.id,
            resourceType: 'TRANSACTION',
            resourceId: created.id,
            record: { action: 'TRANSACTION_CAPTURED', details: {} },
          },
          tx,
        );
        await this.evidence.syncBase(tx, evidenceContext(linked));
        await this.sources.schedule(tx, linked);
        return { transactionId: created.id };
      },
    );
  }

  async list(merchantId: string, query: TransactionQuery) {
    const where = {
      merchantId,
      ...(query.paypalCaptureId
        ? { paypalCaptureId: query.paypalCaptureId }
        : {}),
    };
    return this.prisma.$transaction(
      async (tx) => {
        const items = await tx.transaction.findMany({
          where,
          include: { merchantOrder: true, orderSources: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        const total = await tx.transaction.count({ where });
        return {
          items: await this.responses(tx, items),
          total,
          page: query.page,
          pageSize: query.pageSize,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async detail(merchantId: string, id: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await this.row(tx, merchantId, id);
        return (await this.responses(tx, [row]))[0]!;
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private async row(
    tx: Prisma.TransactionClient,
    merchantId: string,
    id: string,
  ) {
    const row = await tx.transaction.findFirst({
      where: { id, merchantId },
      include: { merchantOrder: true, orderSources: true },
    });
    if (!row)
      throw new ApiException(
        'TRANSACTION_NOT_FOUND',
        'Transaction not found',
        404,
      );
    return row;
  }

  private async responses(
    tx: Prisma.TransactionClient,
    rows: TransactionWithOrder[],
  ) {
    const readiness = await this.evidence.readinessFor(
      tx,
      rows.map(evidenceContext),
    );
    return rows.map((row) => response(row, readiness.get(row.id)!));
  }

  async refreshEvidence(actor: MerchantActor, id: string) {
    return this.prisma.$transaction(
      async (tx) => {
        await lockMerchantOrders(tx, actor.merchantId);
        const row = await reconcileOrder(
          tx,
          await this.row(tx, actor.merchantId, id),
        );
        await this.evidence.syncBase(tx, evidenceContext(row));
        await this.audit.append(
          {
            merchantId: actor.merchantId,
            actorUserId: actor.userId,
            transactionId: id,
            resourceType: 'TRANSACTION',
            resourceId: id,
            record: { action: 'EVIDENCE_REFRESHED', details: {} },
          },
          tx,
        );
        return (await this.responses(tx, [row]))[0]!;
      },
      { timeout: 15000 },
    );
  }

  processNextOrderSource(merchantId: string) {
    return this.sources.processNext(merchantId);
  }
  orderSourceMetrics(merchantId: string) {
    return this.sources.operationalMetrics(merchantId);
  }
  async refreshOrderSources(actor: MerchantActor, id: string) {
    await this.sources.refresh(actor.merchantId, id);
    return this.detail(actor.merchantId, id);
  }

  async registerEvidence(
    actor: MerchantActor,
    id: string,
    input: RegisterEvidence,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await lockMerchantOrders(tx, actor.merchantId);
        const row = await reconcileOrder(
          tx,
          await this.row(tx, actor.merchantId, id),
        );
        const receipt = await this.evidence.register(
          tx,
          evidenceContext(row),
          input,
          actor.userId,
        );
        return {
          ...receipt,
          transaction: (await this.responses(tx, [row]))[0]!,
        };
      },
      { timeout: 15000 },
    );
  }

  async dossier(merchantId: string, id: string) {
    return this.prisma.$transaction(
      async (tx) =>
        this.evidence.dossier(
          tx,
          evidenceContext(await this.row(tx, merchantId, id)),
        ),
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async uploadEvidenceFile(
    actor: MerchantActor,
    id: string,
    input: UploadEvidenceFile,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await this.row(tx, actor.merchantId, id);
        return this.evidence.uploadFile(
          tx,
          evidenceContext(row),
          input,
          actor.userId,
        );
      },
      { timeout: 30000 },
    );
  }

  async downloadEvidenceFile(
    merchantId: string,
    id: string,
    evidenceId: string,
    actorUserId?: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await this.row(tx, merchantId, id);
        return this.evidence.downloadFile(
          tx,
          evidenceContext(row),
          evidenceId,
          actorUserId,
        );
      },
      { timeout: 15000 },
    );
  }

  // Public read interface for M05: payment/order and dossier share one snapshot.
  async investigationSnapshot(merchantId: string, id: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await this.row(tx, merchantId, id);
        return {
          transaction: (await this.responses(tx, [row]))[0]!,
          dossier: await this.evidence.dossier(tx, evidenceContext(row)),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
