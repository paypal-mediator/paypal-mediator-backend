import { Injectable, Logger } from '@nestjs/common';
import {
  MAX_EVIDENCE_FILE_BYTES,
  type UploadEvidenceFile,
} from '@resolve-ai/contracts';
import type {
  ErpConnector,
  ErpCapability,
  SyncPage,
  ErpSecretPayload,
} from '../interfaces/erp-connector.interface.js';

// Odoo (JSON-2 API v19+) — P0.
// Autenticación: API Key (Bearer) + X-Odoo-Database header.
// Base URL: https://<tu-dominio>.odoo.com/json/2
// Modelos: res.partner, sale.order, account.move, account.payment, stock.picking
type OdooMany2One = [number, string] | false;

function applyCursor(domain: unknown[], cursor?: string) {
  if (!cursor) return;
  if (!cursor.startsWith('v1:')) {
    domain.push(['write_date', '>', cursor]);
    return;
  }
  const value = JSON.parse(
    Buffer.from(cursor.slice(3), 'base64url').toString(),
  ) as { date: string; id: number };
  if (
    !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value.date) ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0
  )
    throw new Error('ODOO_CURSOR_INVALID');
  domain.push(
    '|',
    ['write_date', '>', value.date],
    '&',
    ['write_date', '=', value.date],
    ['id', '>', value.id],
  );
}
const pageCursor = (row: { write_date: string; id: number }) =>
  'v1:' +
  Buffer.from(JSON.stringify({ date: row.write_date, id: row.id })).toString(
    'base64url',
  );

@Injectable()
export class OdooAdapter implements ErpConnector {
  readonly provider = 'odoo';
  private readonly logger = new Logger(OdooAdapter.name);

  private getBaseUrl(credentials: ErpSecretPayload): string {
    if (!credentials.baseUrl) {
      throw new Error('Odoo baseUrl required (ej: https://miempresa.odoo.com)');
    }
    return credentials.baseUrl.replace(/\/$/, '') + '/json/2';
  }

  private getHeaders(credentials: ErpSecretPayload): HeadersInit {
    if (!credentials.apiKey) {
      throw new Error('Odoo apiKey required');
    }
    if (!credentials.database) {
      throw new Error('Odoo database name required');
    }
    return {
      Authorization: `bearer ${credentials.apiKey}`,
      'X-Odoo-Database': credentials.database,
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'PayPalAudito/1.0',
    };
  }

  private async call<T>(
    credentials: ErpSecretPayload,
    model: string,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.getBaseUrl(credentials)}/${model}/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(credentials),
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Odoo request failed (${response.status})`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('ODOO_EMPTY_RESPONSE');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error('ODOO_RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof data === 'object' && data !== null && 'error' in data) {
      throw new Error('ODOO_PROVIDER_ERROR');
    }
    return data as T;
  }

  async verifyConnection(credentials: ErpSecretPayload) {
    this.logger.log(`Verifying Odoo connection`);
    // Verificar obteniendo el usuario actual
    const user = await this.call<{ uid: number }>(
      credentials,
      'res.users',
      'context_get',
      { context: { lang: 'en_US' } },
    );
    if (!Number.isInteger(user.uid) || user.uid <= 0)
      throw new Error('Odoo returned an invalid user');
    return {
      externalTenantId: `odoo_${credentials.database}_${user.uid}`,
      capabilities: [
        'customers',
        'sales_orders',
        'invoices',
        'shipments',
      ] as ErpCapability[],
    };
  }

  async pullSalesOrders(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(`Pulling Odoo sale orders, cursor=${cursor ?? 'none'}`);
    const domain: unknown[] = [['state', 'in', ['sale', 'done']]];
    applyCursor(domain, cursor);

    const orders = await this.call<
      Array<{
        id: number;
        name: string;
        partner_id: OdooMany2One;
        date_order: string;
        amount_total: number;
        currency_id: OdooMany2One;
        invoice_ids: number[];
        client_order_ref?: string;
        company_id?: OdooMany2One;
        amount_tax?: number;
        amount_untaxed?: number;
        write_date: string;
      }>
    >(credentials, 'sale.order', 'search_read', {
      domain,
      fields: [
        'id',
        'name',
        'partner_id',
        'date_order',
        'amount_total',
        'currency_id',
        'invoice_ids',
        'client_order_ref',
        'company_id',
        'amount_tax',
        'amount_untaxed',
        'write_date',
      ],
      limit: 100,
      order: 'write_date asc, id asc',
    });

    const lines = orders.length
      ? await this.call<
          Array<{
            id: number;
            order_id: OdooMany2One;
            name: string;
            product_uom_qty: number;
            price_unit: number;
            discount: number;
          }>
        >(credentials, 'sale.order.line', 'search_read', {
          domain: [
            ['order_id', 'in', orders.map((o) => o.id)],
            ['display_type', '=', false],
          ],
          fields: [
            'id',
            'order_id',
            'name',
            'product_uom_qty',
            'price_unit',
            'discount',
          ],
          limit: 1001,
          order: 'id asc',
        })
      : [];
    if (lines.length > 1000) throw new Error('ODOO_ORDER_LINE_LIMIT');
    const records = orders.map((o) => ({
      externalId: String(o.id),
      orderNumber: o.name,
      customerId: o.partner_id ? o.partner_id[0] : 0,
      customerName: o.partner_id ? o.partner_id[1] : 'Unknown',
      orderedAt: o.date_order,
      amount: o.amount_total.toString(),
      currency: o.currency_id ? o.currency_id[1] : null,
      clientOrderReference: o.client_order_ref || null,
      companyId: o.company_id ? o.company_id[0] : null,
      taxAmount: o.amount_tax?.toString() ?? null,
      itemTotal: o.amount_untaxed?.toString() ?? null,
      items: lines
        .filter((l) => l.order_id && l.order_id[0] === o.id)
        .map((l) => ({
          description: l.name,
          quantity: String(l.product_uom_qty),
          unitAmount: String(l.price_unit),
          discount: String(l.discount),
          sku: null,
        })),
      original: {
        order: o,
        lines: lines.filter((l) => l.order_id && l.order_id[0] === o.id),
      },
      invoiceIds: o.invoice_ids,
      writeDate: o.write_date,
    }));

    const lastOrder = orders[orders.length - 1];
    const nextCursor =
      orders.length === 100 && lastOrder ? pageCursor(lastOrder) : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullInvoices(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling Odoo invoices (account.move), cursor=${cursor ?? 'none'}`,
    );
    const domain: unknown[] = [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
    ];
    applyCursor(domain, cursor);

    const invoices = await this.call<
      Array<{
        id: number;
        name: string;
        partner_id: OdooMany2One;
        invoice_date: string;
        amount_total: number;
        currency_id: OdooMany2One;
        payment_reference: string;
        invoice_payment_term_id: OdooMany2One;
        invoice_origin?: string;
        company_id?: OdooMany2One;
        write_date: string;
      }>
    >(credentials, 'account.move', 'search_read', {
      domain,
      fields: [
        'id',
        'name',
        'partner_id',
        'invoice_date',
        'amount_total',
        'currency_id',
        'payment_reference',
        'invoice_payment_term_id',
        'invoice_origin',
        'company_id',
        'write_date',
      ],
      limit: 100,
      order: 'write_date asc, id asc',
    });

    const records = invoices.map((inv) => ({
      externalId: String(inv.id),
      invoiceNumber: inv.name,
      customerId: inv.partner_id ? inv.partner_id[0] : 0,
      customerName: inv.partner_id ? inv.partner_id[1] : 'Unknown',
      date: inv.invoice_date,
      amount: inv.amount_total.toString(),
      currency: inv.currency_id ? inv.currency_id[1] : null,
      invoiceOrigin: inv.invoice_origin || null,
      companyId: inv.company_id ? inv.company_id[0] : null,
      original: inv,
      paymentReference: inv.payment_reference,
      paymentTerm: inv.invoice_payment_term_id
        ? inv.invoice_payment_term_id[1]
        : null,
      writeDate: inv.write_date,
    }));

    const lastInvoice = invoices[invoices.length - 1];
    const nextCursor =
      invoices.length === 100 && lastInvoice
        ? pageCursor(lastInvoice)
        : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullPayments(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(`Pulling Odoo payments, cursor=${cursor ?? 'none'}`);
    const domain: unknown[] = [['partner_type', '=', 'customer']];
    applyCursor(domain, cursor);

    const payments = await this.call<
      Array<{
        id: number;
        name: string;
        partner_id: OdooMany2One;
        date: string;
        amount: number;
        currency_id: OdooMany2One;
        memo: string;
        write_date: string;
      }>
    >(credentials, 'account.payment', 'search_read', {
      domain,
      fields: [
        'id',
        'name',
        'partner_id',
        'date',
        'amount',
        'currency_id',
        'memo',
        'write_date',
      ],
      limit: 100,
      order: 'write_date asc, id asc',
    });

    const records = payments.map((p) => ({
      externalId: String(p.id),
      paymentNumber: p.name,
      customerId: p.partner_id ? p.partner_id[0] : 0,
      customerName: p.partner_id ? p.partner_id[1] : 'Unknown',
      date: p.date,
      amount: p.amount.toString(),
      currency: p.currency_id ? p.currency_id[1] : null,
      original: p,
      reference: p.memo,
      writeDate: p.write_date,
    }));

    const lastPayment = payments[payments.length - 1];
    const nextCursor =
      payments.length === 100 && lastPayment
        ? pageCursor(lastPayment)
        : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullShipments(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling Odoo shipments (stock.picking), cursor=${cursor ?? 'none'}`,
    );
    const domain: unknown[] = [
      ['picking_type_code', '=', 'outgoing'],
      ['state', '=', 'done'],
    ];
    applyCursor(domain, cursor);

    const pickings = await this.call<
      Array<{
        id: number;
        name: string;
        partner_id: OdooMany2One;
        scheduled_date: string;
        origin: string;
        move_ids: number[];
        date_done?: string;
        company_id?: OdooMany2One;
        write_date: string;
      }>
    >(credentials, 'stock.picking', 'search_read', {
      domain,
      fields: [
        'id',
        'name',
        'partner_id',
        'scheduled_date',
        'origin',
        'move_ids',
        'date_done',
        'company_id',
        'write_date',
      ],
      limit: 100,
      order: 'write_date asc, id asc',
    });

    const records = pickings.map((p) => ({
      externalId: String(p.id),
      pickingNumber: p.name,
      customerId: p.partner_id ? p.partner_id[0] : 0,
      customerName: p.partner_id ? p.partner_id[1] : 'Unknown',
      scheduledDate: p.scheduled_date,
      originOrder: p.origin,
      orderExternalId: p.origin,
      shippedAt: p.date_done || null,
      companyId: p.company_id ? p.company_id[0] : null,
      status: 'SHIPPED',
      original: p,
      moveIds: p.move_ids,
      writeDate: p.write_date,
    }));

    const lastPicking = pickings[pickings.length - 1];
    const nextCursor =
      pickings.length === 100 && lastPicking
        ? pageCursor(lastPicking)
        : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async readLinkedDocuments(
    credentials: ErpSecretPayload,
    records: Array<{ recordType: string; externalId: string }>,
    connectionId: string,
  ): Promise<{
    files: Array<Omit<UploadEvidenceFile, 'sourceKind'>>;
    issues: string[];
  }> {
    const models: Record<string, string> = {
      sales_order: 'sale.order',
      invoice: 'account.move',
      shipment: 'stock.picking',
    };
    const targets = records.filter(
      (r) => models[r.recordType] && /^[1-9]\d{0,9}$/.test(r.externalId),
    );
    if (!targets.length) return { files: [], issues: [] };
    const groups = Object.entries(models)
      .map(([type, model]) => ({
        model,
        ids: targets
          .filter((t) => t.recordType === type)
          .map((t) => Number(t.externalId)),
      }))
      .filter((g) => g.ids.length);
    const domain = [
      ['type', '=', 'binary'],
      ...Array(Math.max(0, groups.length - 1)).fill('|'),
      ...groups.flatMap((g) => [
        '&',
        ['res_model', '=', g.model],
        ['res_id', 'in', g.ids],
      ]),
    ];
    const metadata = await this.call<
      Array<{
        id: number;
        name: string;
        mimetype: string;
        file_size: number;
        res_model: string;
        res_id: number;
        write_date: string;
      }>
    >(credentials, 'ir.attachment', 'search_read', {
      domain,
      fields: [
        'id',
        'name',
        'mimetype',
        'file_size',
        'res_model',
        'res_id',
        'write_date',
      ],
      limit: 4,
      order: 'id asc',
    });
    const files: Array<Omit<UploadEvidenceFile, 'sourceKind'>> = [],
      issues: string[] = [];
    if (metadata.length > 3) issues.push('ODOO_DOCUMENT_LIMIT');
    for (const meta of metadata.slice(0, 3)) {
      if (
        !groups.some(
          (g) => g.model === meta.res_model && g.ids.includes(meta.res_id),
        )
      )
        throw new Error('ODOO_ATTACHMENT_PARENT_MISMATCH');
      if (
        !['application/pdf', 'image/png', 'image/jpeg'].includes(meta.mimetype)
      ) {
        issues.push('ODOO_DOCUMENT_TYPE_UNSUPPORTED');
        continue;
      }
      if (
        !Number.isSafeInteger(meta.file_size) ||
        meta.file_size <= 0 ||
        meta.file_size > MAX_EVIDENCE_FILE_BYTES
      ) {
        issues.push('ODOO_DOCUMENT_SIZE_UNSUPPORTED');
        continue;
      }
      const rows = await this.call<Array<typeof meta & { datas: string }>>(
        credentials,
        'ir.attachment',
        'read',
        {
          ids: [meta.id],
          fields: [
            'id',
            'datas',
            'name',
            'mimetype',
            'file_size',
            'res_model',
            'res_id',
            'write_date',
          ],
          context: { bin_size: false },
        },
      );
      const file = rows[0];
      if (
        rows.length !== 1 ||
        !file ||
        file.id !== meta.id ||
        file.res_model !== meta.res_model ||
        file.res_id !== meta.res_id ||
        file.write_date !== meta.write_date ||
        file.mimetype !== meta.mimetype ||
        typeof file.datas !== 'string'
      )
        throw new Error('ODOO_ATTACHMENT_CHANGED');
      const bytes = Buffer.from(file.datas, 'base64');
      if (
        bytes.length !== meta.file_size ||
        bytes.toString('base64') !== file.datas ||
        bytes.length > MAX_EVIDENCE_FILE_BYTES
      )
        throw new Error('ODOO_ATTACHMENT_INTEGRITY_FAILED');
      files.push({
        sourceSystem: `odoo:${connectionId}`,
        externalReference: `${meta.res_model}:${meta.res_id}:attachment:${meta.id}`,
        retrievedAt: new Date().toISOString(),
        fileName: file.name
          .split('')
          .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
          .join('')
          .replace(/[<>:"/\\|?*]/g, '_')
          .slice(0, 180),
        mediaType: file.mimetype as UploadEvidenceFile['mediaType'],
        dataBase64: file.datas,
      });
    }
    return { files, issues: [...new Set(issues)] };
  }

  async disconnect(_credentials: ErpSecretPayload): Promise<void> {
    this.logger.log(`Disconnecting Odoo`);
    void _credentials;
    // API Keys se revocan desde la UI de Odoo; no hay endpoint programático estándar
  }
}
