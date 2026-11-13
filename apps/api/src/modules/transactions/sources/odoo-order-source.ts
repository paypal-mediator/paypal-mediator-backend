import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  DecimalAmountSchema,
  OrderSourceResultSchema,
  type NormalizedSourceOrder,
} from '@resolve-ai/contracts';
import type { Transaction, Prisma } from '../../../generated/prisma/client.js';
import { OdooRecordsService } from '../../integrations/index.js';
import { OdooSnapshotSchema, odooReference } from '../../integrations/index.js';
import { ApiException } from '../../../common/http/api.exception.js';
import {
  type OrderInformationSource,
  type OrderSourceFetch,
  OrderSourceError,
} from './order-information-source.js';

const date = (value: unknown) => {
  if (typeof value !== 'string' || !value) return null;
  const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : null;
};
const decimal = (value: unknown) =>
  DecimalAmountSchema.safeParse(value).success ? String(value) : null;
const currency = (value: unknown) =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;

@Injectable()
export class OdooOrderSource implements OrderInformationSource {
  readonly providerId = 'ODOO';
  readonly sourceKind = 'CONNECTED_SYSTEM' as const;
  readonly sourceSystem = 'odoo';
  readonly pollIntervalMs = 60000;
  constructor(
    @Inject(OdooRecordsService) private readonly records: OdooRecordsService,
  ) {}
  supports() {
    return true;
  }
  available(merchantId: string, tx?: Prisma.TransactionClient) {
    return this.records.available(merchantId, tx);
  }
  private context(row: Transaction) {
    return {
      merchantId: row.merchantId,
      paypalCaptureId: row.paypalCaptureId,
      paypalOrderId: row.paypalOrderId,
      merchantOrderReference: row.merchantOrderReference,
      invoiceId: row.invoiceId,
      currencyCode: row.currencyCode,
      amount: row.amount.toFixed(),
    };
  }

  async fetch(row: Transaction): Promise<OrderSourceFetch> {
    try {
      const snapshot = await this.records.snapshot(this.context(row));
      const issues = [...snapshot.issues],
        missingFields: string[] = [];
      for (const r of snapshot.records) {
        if (!snapshot.directIds.has(r.id) || r.recordType === 'shipment')
          continue;
        const p = r.normalizedPayload;
        if (currency(p.currency) !== row.currencyCode)
          issues.push('ODOO_CURRENCY_MISMATCH');
        const amount = decimal(p.amount);
        if (!amount || !row.amount.equals(amount))
          issues.push('ODOO_AMOUNT_MISMATCH');
      }
      const orderRecord = snapshot.records.find(
        (r) => r.recordType === 'sales_order',
      );
      const invoices = snapshot.records.filter(
        (r) => r.recordType === 'invoice',
      );
      const invoice =
        invoices.find(
          (r) => r.normalizedPayload.invoiceNumber === row.invoiceId,
        ) ?? (invoices.length === 1 ? invoices[0] : undefined);
      if (
        row.invoiceId &&
        invoices.length &&
        !invoices.some(
          (r) => r.normalizedPayload.invoiceNumber === row.invoiceId,
        )
      )
        issues.push('ODOO_INVOICE_REFERENCE_CONFLICT');
      let order: NormalizedSourceOrder | null = null;
      if (orderRecord) {
        const p = orderRecord.normalizedPayload;
        const code = currency(p.currency);
        const items = (Array.isArray(p.items) ? p.items : [])
          .slice(0, 100)
          .map((value) => {
            const item = value as Record<string, unknown>;
            const qty = Number(item.quantity);
            return {
              sku: odooReference(item.sku),
              description:
                odooReference(item.description)?.slice(0, 500) ?? null,
              quantity: Number.isSafeInteger(qty) && qty > 0 ? qty : null,
              unitAmount: decimal(item.unitAmount),
              currencyCode: code,
            };
          });
        if (Array.isArray(p.items) && p.items.length > 100)
          issues.push('ODOO_ORDER_ITEM_LIMIT');
        order = {
          providerId: this.providerId,
          sourceKind: this.sourceKind,
          sourceSystem: this.sourceSystem,
          externalId: `${orderRecord.connectionId}:sale.order:${orderRecord.externalId}`,
          paypalOrderId: odooReference(p.paypalOrderId),
          merchantOrderReference: [
            p.orderNumber,
            p.clientOrderReference,
          ].includes(row.merchantOrderReference)
            ? row.merchantOrderReference
            : null,
          invoiceId: invoice
            ? odooReference(invoice.normalizedPayload.invoiceNumber)
            : null,
          purchaseUnitReference: null,
          currencyCode: code,
          totalAmount: decimal(p.amount),
          shippingAmount: null,
          taxAmount: decimal(p.taxAmount),
          discountAmount: null,
          orderedAt: date(p.orderedAt),
          items,
          breakdown: {
            itemTotal:
              code && decimal(p.itemTotal)
                ? { currencyCode: code, value: decimal(p.itemTotal)! }
                : null,
            tax:
              code && decimal(p.taxAmount)
                ? { currencyCode: code, value: decimal(p.taxAmount)! }
                : null,
            shipping: null,
            handling: null,
            insurance: null,
            shippingDiscount: null,
            discount: null,
          },
        };
        if (!order.orderedAt) missingFields.push('ORDER_DATE');
        if (
          !items.length ||
          items.some(
            (i) =>
              !i.description || i.quantity === null || i.unitAmount === null,
          )
        )
          missingFields.push('ORDER_ITEMS');
        if (!order.currencyCode || !order.totalAmount)
          missingFields.push('ORDER_AMOUNT');
      } else missingFields.push('ORDER_RECORD');
      if (!snapshot.records.length)
        missingFields.push('ODOO_EXACT_REFERENCE_NOT_FOUND');
      const association = issues.length
        ? 'CONFLICT'
        : snapshot.records.length
          ? 'MATCHED'
          : 'UNRESOLVED';
      let documents: Awaited<ReturnType<OdooRecordsService['documents']>> = {
        files: [],
        issues: [],
      };
      let documentStatus:
        'IMPORTED' | 'NOT_FOUND' | 'UNAVAILABLE' | 'NOT_REQUESTED' =
        'NOT_REQUESTED';
      if (association === 'MATCHED') {
        try {
          documents = await this.records.documents(
            row.merchantId,
            snapshot.records,
          );
          documentStatus = documents.files.length
            ? 'IMPORTED'
            : documents.issues.length
              ? 'UNAVAILABLE'
              : 'NOT_FOUND';
        } catch {
          documents = { files: [], issues: ['ODOO_DOCUMENTS_UNAVAILABLE'] };
          documentStatus = 'UNAVAILABLE';
        }
        if (!documents.files.length || documents.issues.length)
          missingFields.push('ODOO_ORIGINAL_DOCUMENTS');
      }
      const result = OrderSourceResultSchema.parse({
        order,
        association,
        issues: [...new Set(issues)],
        missingFields,
        relatedRecords: snapshot.records.map((r) => {
          const p = r.normalizedPayload,
            code = currency(p.currency),
            amount = decimal(p.amount);
          return {
            recordId: r.id,
            connectionId: r.connectionId,
            recordType: r.recordType,
            externalId: r.externalId,
            reference: odooReference(
              p.orderNumber ??
                p.invoiceNumber ??
                p.paymentNumber ??
                p.pickingNumber,
            ),
            amount:
              code && amount ? { currencyCode: code, value: amount } : null,
            trackingNumber: odooReference(p.trackingNumber),
            carrier: odooReference(p.carrier),
            shippedAt: date(p.shippedAt),
            matchMethod: snapshot.directIds.has(r.id)
              ? 'odoo_reference_exact'
              : 'odoo_relation_exact',
          };
        }),
        documentImport: {
          status: documentStatus,
          count: documents.files.length,
          issues: documents.issues,
        },
      });
      return {
        original: {
          records: snapshot.records,
          directIds: [...snapshot.directIds],
        },
        result,
        files: documents.files,
      };
    } catch (error) {
      if (error instanceof ApiException)
        throw new OrderSourceError(
          error.code,
          error.code === 'ODOO_RECORD_CHANGED',
        );
      throw new OrderSourceError('ODOO_SOURCE_UNAVAILABLE', true);
    }
  }

  async commit(
    row: Transaction,
    fetched: OrderSourceFetch,
    tx: Prisma.TransactionClient,
  ) {
    const snapshot = z
      .object({
        records: z.array(OdooSnapshotSchema).max(100),
        directIds: z.array(z.uuid()).max(100),
      })
      .parse(fetched.original);
    await this.records.replaceLinks(
      this.context(row),
      fetched.result.association === 'MATCHED' ? snapshot.records : [],
      new Set(snapshot.directIds),
      tx,
    );
  }
}
