import { Inject, Injectable } from '@nestjs/common';
import {
  EvidenceDossierResponseSchema,
  RegisterEvidenceSchema,
  type RegisterEvidence,
  UploadEvidenceFileSchema,
  EvidenceFileMetadataSchema,
  MAX_EVIDENCE_FILE_BYTES,
  type UploadEvidenceFile,
} from '@resolve-ai/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import { contentHash } from '../../common/data/content-hash.js';
import { ApiException } from '../../common/http/api.exception.js';
import { paymentRecord, type EvidenceContext } from './evidence-context.js';
import { currentEvidence, evaluateEvidence } from './evidence-readiness.js';
import { EvidenceStorage, binaryHash } from './evidence-storage.js';
import { PdfTextExtractor } from './pdf-text-extractor.js';
import { AuditService } from '../monitoring/audit.service.js';

interface EvidenceRecord {
  type:
    | 'PAYMENT_RECORD'
    | 'ORDER_RECORD'
    | 'ORDER_SOURCE_RECORD'
    | 'TRACKING'
    | 'PROOF_OF_DELIVERY'
    | 'DOCUMENT';
  sourceKind: 'PAYPAL' | 'CONNECTED_SYSTEM' | 'MERCHANT_INPUT' | 'DEMO';
  sourceSystem: string;
  externalReference: string;
  retrievedAt: string;
  content: Record<string, unknown>;
}

@Injectable()
export class EvidenceService {
  // Trusted module interface; no controller accepts this provenance.
  async recordOrderSource(
    tx: Prisma.TransactionClient,
    context: EvidenceContext,
    record: Pick<
      EvidenceRecord,
      'sourceKind' | 'sourceSystem' | 'externalReference' | 'content'
    >,
  ) {
    return this.append(
      tx,
      context,
      {
        ...record,
        type: 'ORDER_SOURCE_RECORD',
        retrievedAt: new Date().toISOString(),
      },
      null,
    );
  }
  constructor(
    @Inject(EvidenceStorage) private readonly storage: EvidenceStorage,
    @Inject(PdfTextExtractor) private readonly pdfExtractor: PdfTextExtractor,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async uploadFile(
    tx: Prisma.TransactionClient,
    context: EvidenceContext,
    input: UploadEvidenceFile,
    actorUserId: string,
  ) {
    const parsed = UploadEvidenceFileSchema.parse(input);
    const bytes = Buffer.from(parsed.dataBase64, 'base64');
    const signatures = {
      'application/pdf': Buffer.from('%PDF-'),
      'image/png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      'image/jpeg': Buffer.from([255, 216, 255]),
    };
    if (
      !bytes.length ||
      bytes.length > MAX_EVIDENCE_FILE_BYTES ||
      bytes.toString('base64') !== parsed.dataBase64 ||
      !bytes
        .subarray(0, signatures[parsed.mediaType].length)
        .equals(signatures[parsed.mediaType])
    )
      throw new ApiException(
        'EVIDENCE_FILE_INVALID',
        'Invalid file size, encoding or signature',
        400,
      );
    if (Date.parse(parsed.retrievedAt) > Date.now() + 300000)
      throw new ApiException(
        'EVIDENCE_DATE_INVALID',
        'Evidence dates are inconsistent',
        400,
      );
    const sha256 = binaryHash(bytes);
    let extractedText: string | undefined;
    if (parsed.mediaType === 'application/pdf') {
      extractedText = await this.pdfExtractor.extract(bytes);
    }
    const receipt = await this.append(
      tx,
      context,
      {
        type: 'DOCUMENT',
        sourceKind: parsed.sourceKind,
        sourceSystem: parsed.sourceSystem,
        externalReference: parsed.externalReference,
        retrievedAt: parsed.retrievedAt,
        content: {
          fileName: parsed.fileName,
          mediaType: parsed.mediaType,
          byteLength: bytes.length,
          sha256,
          ...(extractedText ? { extractedText } : {}),
        },
      },
      actorUserId,
    );
    // Validate provenance/version constraints before creating an external object.
    // A storage failure rolls back the uncommitted metadata and revision.
    await this.storage.put(
      this.fileKey(context, sha256),
      bytes,
      parsed.mediaType,
    );
    return receipt;
  }

  private fileKey(context: EvidenceContext, sha256: string) {
    return `${context.merchantId}/${context.transactionId}/${sha256}`;
  }

  async downloadFile(
    tx: Prisma.TransactionClient,
    context: EvidenceContext,
    evidenceId: string,
    actorUserId?: string,
  ) {
    const item = await tx.evidenceItem.findFirst({
      where: {
        id: evidenceId,
        type: 'DOCUMENT',
        dossier: {
          merchantId: context.merchantId,
          transactionId: context.transactionId,
        },
      },
    });
    if (!item)
      throw new ApiException(
        'EVIDENCE_FILE_NOT_FOUND',
        'Evidence file not found',
        404,
      );
    const metadata = EvidenceFileMetadataSchema.safeParse(item.content);
    if (!metadata.success || item.contentHash !== contentHash(item.content))
      throw new ApiException(
        'EVIDENCE_FILE_INTEGRITY_MISMATCH',
        'File metadata integrity check failed',
        409,
      );
    await this.storage.ensurePrivate();
    const bytes = await this.storage.get(
      this.fileKey(context, metadata.data.sha256),
    );
    if (
      bytes.length !== metadata.data.byteLength ||
      binaryHash(bytes) !== metadata.data.sha256
    )
      throw new ApiException(
        'EVIDENCE_FILE_INTEGRITY_MISMATCH',
        'Stored file integrity check failed',
        409,
      );
    await this.audit.append(
      {
        merchantId: context.merchantId,
        actorUserId: actorUserId ?? null,
        actorKind: actorUserId ? 'USER' : 'SYSTEM',
        transactionId: context.transactionId,
        resourceType: 'EVIDENCE',
        resourceId: item.id,
        record: {
          action: 'EVIDENCE_DOWNLOADED',
          details: { evidenceType: 'DOCUMENT' },
        },
      },
      tx,
    );
    return { bytes, ...metadata.data };
  }
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
    await this.audit.append(
      {
        merchantId: context.merchantId,
        actorUserId,
        actorKind: actorUserId ? 'USER' : 'SYSTEM',
        transactionId: context.transactionId,
        resourceType: 'EVIDENCE',
        resourceId: item.id,
        record: {
          action: 'EVIDENCE_APPENDED',
          details: {
            evidenceType: record.type,
            sourceKind: record.sourceKind,
            version: revision,
          },
        },
      },
      tx,
    );
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
    for (const order of context.orders ??
      (context.order ? [context.order] : []))
      await this.append(
        tx,
        context,
        {
          type: 'ORDER_RECORD',
          sourceKind: order.sourceKind,
          sourceSystem: order.sourceSystem,
          externalReference: order.externalId,
          retrievedAt: new Date().toISOString(),
          content: { ...order },
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
