import { Injectable } from '@nestjs/common';
import {
  EvidenceDossierResponseSchema,
  RegisterEvidenceSchema,
  type RegisterEvidence,
} from '@resolve-ai/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import { contentHash } from '../../common/data/content-hash.js';
import { ApiException } from '../../common/http/api.exception.js';
import { paymentRecord, type EvidenceContext } from './evidence-context.js';
import { currentEvidence, evaluateEvidence } from './evidence-readiness.js';

interface EvidenceRecord {
  type: 'PAYMENT_RECORD' | 'ORDER_RECORD' | 'TRACKING' | 'PROOF_OF_DELIVERY';
  sourceKind: 'PAYPAL' | 'MERCHANT_INPUT' | 'DEMO';
  sourceSystem: string;
  externalReference: string;
  retrievedAt: string;
  content: Record<string, unknown>;
}

@Injectable()
export class EvidenceService {
  private async append(
    tx: Prisma.TransactionClient,
    context: EvidenceContext,
    record: EvidenceRecord,
    actorUserId: string | null,
  ) {
    const key = `evidence:${context.transactionId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
    const dossier = await tx.evidenceDossier.upsert({
      where: { transactionId: context.transactionId },
      create: {
        merchantId: context.merchantId,
        transactionId: context.transactionId,
      },
      update: {},
    });
    if (dossier.merchantId !== context.merchantId)
      throw new ApiException(
        'EVIDENCE_ACCESS_DENIED',
        'Evidence access denied',
        403,
      );
    const logicalKey = contentHash([
      record.type,
      record.sourceSystem,
      record.externalReference,
    ]);
    const hash = contentHash(record.content);
    const latest = await tx.evidenceItem.findFirst({
      where: { dossierId: dossier.id, logicalKey },
      orderBy: { version: 'desc' },
    });
    if (latest && latest.sourceKind !== record.sourceKind)
      throw new ApiException(
        'EVIDENCE_SOURCE_CONFLICT',
        'Evidence provenance cannot be relabeled',
        409,
      );
    if (latest?.contentHash === hash)
      return {
        outcome: 'DUPLICATE' as const,
        evidenceId: latest.id,
        version: latest.version,
      };
    if (latest && Date.parse(record.retrievedAt) < latest.retrievedAt.getTime())
      throw new ApiException(
        'EVIDENCE_STALE_VERSION',
        'Older evidence cannot replace a newer source record',
        409,
      );
    if (dossier.revision >= 256)
      throw new ApiException(
        'EVIDENCE_LIMIT_REACHED',
        'Dossier revision limit reached',
        409,
      );
    const revision = dossier.revision + 1;
    const item = await tx.evidenceItem.create({
      data: {
        dossierId: dossier.id,
        ...record,
        retrievedAt: new Date(record.retrievedAt),
        content: record.content as Prisma.InputJsonValue,
        logicalKey,
        version: revision,
        contentHash: hash,
        actorUserId,
      },
    });
    await tx.evidenceDossier.update({
      where: { id: dossier.id },
      data: { revision },
    });
    return {
      outcome: 'CREATED' as const,
      evidenceId: item.id,
      version: revision,
    };
  }

  async syncBase(tx: Prisma.TransactionClient, context: EvidenceContext) {
    await this.append(
      tx,
      context,
      {
        type: 'PAYMENT_RECORD',
        sourceKind: 'PAYPAL',
        sourceSystem: 'paypal-sandbox',
        externalReference: context.paypalCaptureId,
        retrievedAt: new Date().toISOString(),
        content: paymentRecord(context),
      },
      null,
    );
    if (context.order)
      await this.append(
        tx,
        context,
        {
          type: 'ORDER_RECORD',
          sourceKind: context.order.sourceKind,
          sourceSystem: context.order.sourceSystem,
          externalReference: context.order.externalId,
          retrievedAt: new Date().toISOString(),
          content: { ...context.order },
        },
        context.orderRecordedBy,
      );
  }

  async register(
    tx: Prisma.TransactionClient,
    context: EvidenceContext,
    input: RegisterEvidence,
    actorUserId: string,
  ) {
    const parsed = RegisterEvidenceSchema.parse(input);
    if (!context.order)
      throw new ApiException(
        'ORDER_REQUIRED',
        'A matching commercial order is required',
        409,
      );
    if (
      parsed.content.paypalCaptureId !== context.paypalCaptureId ||
      parsed.content.merchantOrderReference !== context.order.externalId
    )
      throw new ApiException(
        'EVIDENCE_IDENTITY_MISMATCH',
        'Evidence does not match the transaction and order',
        409,
      );
    const observedAt =
      parsed.type === 'TRACKING'
        ? parsed.content.shippedAt
        : parsed.content.deliveredAt;
    if (
      Date.parse(parsed.retrievedAt) > Date.now() + 300000 ||
      Date.parse(observedAt) > Date.parse(parsed.retrievedAt)
    )
      throw new ApiException(
        'EVIDENCE_DATE_INVALID',
        'Evidence dates are inconsistent',
        400,
      );
    await this.syncBase(tx, context);
    return this.append(tx, context, parsed, actorUserId);
  }

  async readinessFor(
    tx: Prisma.TransactionClient,
    contexts: EvidenceContext[],
  ) {
    const result = new Map<string, ReturnType<typeof evaluateEvidence>>();
    if (!contexts.length) return result;
    const dossiers = await tx.evidenceDossier.findMany({
      where: {
        merchantId: contexts[0]!.merchantId,
        transactionId: { in: contexts.map((c) => c.transactionId) },
      },
      include: { items: true },
    });
    for (const context of contexts)
      result.set(
        context.transactionId,
        evaluateEvidence(
          context,
          dossiers.find((d) => d.transactionId === context.transactionId) ??
            null,
        ),
      );
    return result;
  }

  async dossier(tx: Prisma.TransactionClient, context: EvidenceContext) {
    const dossier = await tx.evidenceDossier.findFirst({
      where: {
        merchantId: context.merchantId,
        transactionId: context.transactionId,
      },
      include: { items: { orderBy: { version: 'desc' } } },
    });
    if (!dossier)
      throw new ApiException(
        'DOSSIER_NOT_FOUND',
        'Refresh the transaction evidence to create its dossier',
        404,
      );
    const current = new Set(
      currentEvidence(dossier.items).map((item) => item.id),
    );
    return EvidenceDossierResponseSchema.parse({
      ...dossier,
      items: dossier.items.map((item) => ({
        ...item,
        retrievedAt: item.retrievedAt.toISOString(),
        current: current.has(item.id),
        integrity:
          item.contentHash === contentHash(item.content) ? 'VALID' : 'INVALID',
      })),
    });
  }
}
