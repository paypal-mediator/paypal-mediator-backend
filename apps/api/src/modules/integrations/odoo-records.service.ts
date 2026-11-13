import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { contentHash } from '../../common/data/content-hash.js';
import { ApiException } from '../../common/http/api.exception.js';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { decryptErpSecret } from '../../common/crypto/secret-box.js';
import { OdooAdapter } from './adapters/odoo.adapter.js';
import {
  type OdooPaymentReference,
  type OdooRecordSnapshot,
  selectOdooRecords,
  odooReference,
} from './odoo-association.js';

@Injectable()
export class OdooRecordsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(OdooAdapter) private readonly adapter: OdooAdapter,
  ) {}

  async available(
    merchantId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    return Boolean(
      await tx.erpConnection.findFirst({
        where: {
          merchantId,
          provider: 'odoo',
          status: { in: ['connected', 'syncing'] },
        },
        select: { id: true },
      }),
    );
  }

  async snapshot(context: OdooPaymentReference) {
    const references = [
      ...new Set(
        [
          context.paypalCaptureId,
          context.paypalOrderId,
          context.merchantOrderReference,
          context.invoiceId,
        ].filter((r): r is string => Boolean(r)),
      ),
    ];
    const scope = {
      merchantId: context.merchantId,
      connection: {
        merchantId: context.merchantId,
        provider: 'odoo',
        status: { in: ['connected', 'syncing'] },
      },
    };
    const collected = new Map<string, OdooRecordSnapshot>();
    const read = async (OR: Prisma.ExternalRecordWhereInput[]) => {
      if (!OR.length) return;
      const rows = await this.prisma.externalRecord.findMany({
        where: {
          ...scope,
          recordType: { in: ['sales_order', 'invoice', 'payment', 'shipment'] },
          OR,
        },
        take: 101,
        orderBy: { id: 'asc' },
      });
      if (rows.length > 100)
        throw new ApiException(
          'ODOO_CANDIDATE_LIMIT',
          'Too many matching Odoo records; review references',
          409,
        );
      for (const row of rows) {
        if (contentHash(row.normalizedPayload) !== row.sourceHash)
          throw new ApiException(
            'ODOO_RECORD_INTEGRITY_MISMATCH',
            'Imported Odoo record integrity failed',
            409,
          );
        collected.set(row.id, {
          id: row.id,
          connectionId: row.connectionId,
          recordType: row.recordType,
          externalId: row.externalId,
          sourceHash: row.sourceHash,
          normalizedPayload: row.normalizedPayload as Record<string, unknown>,
        });
      }
      if (collected.size > 100)
        throw new ApiException(
          'ODOO_CANDIDATE_LIMIT',
          'Too many related Odoo records',
          409,
        );
    };
    await read(
      [
        'paypalCaptureId',
        'paypalOrderId',
        'orderNumber',
        'clientOrderReference',
        'invoiceNumber',
        'paymentReference',
        'reference',
        'originOrder',
      ].flatMap((field) =>
        references.map((value) => ({
          normalizedPayload: { path: [field], equals: value },
        })),
      ),
    );
    for (let iteration = 0; iteration < 3; iteration++) {
      const before = collected.size;
      const related: Prisma.ExternalRecordWhereInput[] = [];
      for (const r of collected.values()) {
        const p = r.normalizedPayload;
        const field = (key: string, value: string, recordType?: string) =>
          related.push({
            connectionId: r.connectionId,
            ...(recordType ? { recordType } : {}),
            normalizedPayload: { path: [key], equals: value },
          });
        if (r.recordType === 'sales_order') {
          const number = odooReference(p.orderNumber);
          if (number) {
            field('invoiceOrigin', number, 'invoice');
            field('originOrder', number, 'shipment');
            field('reference', number, 'payment');
          }
          if (Array.isArray(p.invoiceIds))
            for (const id of p.invoiceIds)
              if (Number.isSafeInteger(id) && Number(id) > 0)
                related.push({
                  connectionId: r.connectionId,
                  recordType: 'invoice',
                  externalId: String(id),
                });
        }
        if (r.recordType === 'invoice') {
          const origin = odooReference(p.invoiceOrigin),
            number = odooReference(p.invoiceNumber);
          if (origin) field('orderNumber', origin, 'sales_order');
          if (number) field('reference', number, 'payment');
          if (/^\d+$/.test(r.externalId))
            related.push({
              connectionId: r.connectionId,
              recordType: 'sales_order',
              normalizedPayload: {
                path: ['invoiceIds'],
                array_contains: [Number(r.externalId)],
              },
            });
        }
        if (r.recordType === 'shipment') {
          const origin = odooReference(p.originOrder);
          if (origin) field('orderNumber', origin, 'sales_order');
        }
        if (r.recordType === 'payment') {
          const reference = odooReference(p.reference);
          if (reference) {
            field('invoiceNumber', reference, 'invoice');
            field('orderNumber', reference, 'sales_order');
          }
        }
      }
      await read(related);
      if (before === collected.size) break;
    }
    return selectOdooRecords([...collected.values()], context);
  }

  // Integration-owned links participate in M03's unit of work; no M03 table writes.
  async replaceLinks(
    context: OdooPaymentReference,
    records: OdooRecordSnapshot[],
    directIds: Set<string>,
    tx: Prisma.TransactionClient,
  ) {
    for (const connectionId of [
      ...new Set(records.map((r) => r.connectionId)),
    ].sort()) {
      const locked = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM erp_connections WHERE id=${connectionId}::uuid AND merchant_id=${context.merchantId}::uuid AND provider='odoo' AND status IN ('connected','syncing') FOR SHARE`;
      if (!locked.length)
        throw new ApiException(
          'ODOO_RECORD_CHANGED',
          'Odoo connection changed during association; retry',
          409,
        );
    }
    for (const record of [...records].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      await tx.$queryRaw`SELECT id FROM external_records WHERE id=${record.id}::uuid AND merchant_id=${context.merchantId}::uuid FOR SHARE`;
      const current = await tx.externalRecord.findFirst({
        where: {
          id: record.id,
          merchantId: context.merchantId,
          connectionId: record.connectionId,
          connection: {
            merchantId: context.merchantId,
            provider: 'odoo',
            status: { in: ['connected', 'syncing'] },
          },
        },
      });
      if (
        !current ||
        current.sourceHash !== record.sourceHash ||
        contentHash(current.normalizedPayload) !== record.sourceHash
      )
        throw new ApiException(
          'ODOO_RECORD_CHANGED',
          'Odoo records changed during association; retry',
          409,
        );
    }
    await tx.transactionLink.deleteMany({
      where: {
        merchantId: context.merchantId,
        paypalCaptureId: context.paypalCaptureId,
        reviewedBy: null,
        matchMethod: { in: ['odoo_reference_exact', 'odoo_relation_exact'] },
        recordId: { notIn: records.map((r) => r.id) },
      },
    });
    for (const record of records)
      await tx.transactionLink.upsert({
        where: {
          merchantId_paypalCaptureId_recordId: {
            merchantId: context.merchantId,
            paypalCaptureId: context.paypalCaptureId,
            recordId: record.id,
          },
        },
        create: {
          merchantId: context.merchantId,
          paypalCaptureId: context.paypalCaptureId,
          paypalOrderId: context.paypalOrderId,
          recordId: record.id,
          confidence: 'high',
          matchMethod: directIds.has(record.id)
            ? 'odoo_reference_exact'
            : 'odoo_relation_exact',
        },
        update: {},
      });
  }

  async documents(merchantId: string, records: OdooRecordSnapshot[]) {
    if (!records.length) return { files: [], issues: [] };
    const connectionId = records[0]!.connectionId;
    if (records.some((r) => r.connectionId !== connectionId))
      throw new Error('ODOO_AMBIGUOUS_CONNECTION');
    const connection = await this.prisma.erpConnection.findFirst({
      where: {
        id: connectionId,
        merchantId,
        provider: 'odoo',
        status: { in: ['connected', 'syncing'] },
      },
      include: { secret: true },
    });
    if (!connection?.secret) throw new Error('ODOO_CONNECTION_UNAVAILABLE');
    const credentials = await decryptErpSecret(
      connection.secret.encryptedPayload,
      this.env,
    );
    return this.adapter.readLinkedDocuments(
      credentials,
      records.map((r) => ({
        recordType: r.recordType,
        externalId: r.externalId,
      })),
      connectionId,
    );
  }
}
