import { Injectable, Logger } from '@nestjs/common';
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

    const data: unknown = await response.json();
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const err = data as {
        error: { message: string; data: { debug: string } };
      };
      throw new Error(
        `Odoo error: ${err.error.message}\n${err.error.data.debug}`,
      );
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
    if (cursor) {
      domain.push(['write_date', '>', cursor]);
    }

    const orders = await this.call<
      Array<{
        id: number;
        name: string;
        partner_id: OdooMany2One;
        date_order: string;
        amount_total: number;
        currency_id: OdooMany2One;
        invoice_ids: number[];
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
        'write_date',
      ],
      limit: 100,
      order: 'write_date asc',
    });

    const records = orders.map((o) => ({
      externalId: String(o.id),
      orderNumber: o.name,
      customerId: o.partner_id ? o.partner_id[0] : 0,
      customerName: o.partner_id ? o.partner_id[1] : 'Unknown',
      orderedAt: o.date_order,
      amount: o.amount_total.toString(),
      currency: o.currency_id ? o.currency_id[1] : 'USD',
      invoiceIds: o.invoice_ids,
      writeDate: o.write_date,
    }));

    const lastOrder = orders[orders.length - 1];
    const nextCursor =
      orders.length === 100 && lastOrder ? lastOrder.write_date : undefined;

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
    if (cursor) {
      domain.push(['write_date', '>', cursor]);
    }

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
        'write_date',
      ],
      limit: 100,
      order: 'write_date asc',
    });

    const records = invoices.map((inv) => ({
      externalId: String(inv.id),
      invoiceNumber: inv.name,
      customerId: inv.partner_id ? inv.partner_id[0] : 0,
      customerName: inv.partner_id ? inv.partner_id[1] : 'Unknown',
      date: inv.invoice_date,
      amount: inv.amount_total.toString(),
      currency: inv.currency_id ? inv.currency_id[1] : 'USD',
      paymentReference: inv.payment_reference,
      paymentTerm: inv.invoice_payment_term_id
        ? inv.invoice_payment_term_id[1]
        : null,
      writeDate: inv.write_date,
    }));

    const lastInvoice = invoices[invoices.length - 1];
    const nextCursor =
      invoices.length === 100 && lastInvoice
        ? lastInvoice.write_date
        : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullPayments(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(`Pulling Odoo payments, cursor=${cursor ?? 'none'}`);
    const domain: unknown[] = [['partner_type', '=', 'customer']];
    if (cursor) {
      domain.push(['write_date', '>', cursor]);
    }

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
      order: 'write_date asc',
    });

    const records = payments.map((p) => ({
      externalId: String(p.id),
      paymentNumber: p.name,
      customerId: p.partner_id ? p.partner_id[0] : 0,
      customerName: p.partner_id ? p.partner_id[1] : 'Unknown',
      date: p.date,
      amount: p.amount.toString(),
      currency: p.currency_id ? p.currency_id[1] : 'USD',
      reference: p.memo,
      writeDate: p.write_date,
    }));

    const lastPayment = payments[payments.length - 1];
    const nextCursor =
      payments.length === 100 && lastPayment
        ? lastPayment.write_date
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
    if (cursor) {
      domain.push(['write_date', '>', cursor]);
    }

    const pickings = await this.call<
      Array<{
        id: number;
        name: string;
        partner_id: OdooMany2One;
        scheduled_date: string;
        origin: string;
        move_ids: number[];
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
        'write_date',
      ],
      limit: 100,
      order: 'write_date asc',
    });

    const records = pickings.map((p) => ({
      externalId: String(p.id),
      pickingNumber: p.name,
      customerId: p.partner_id ? p.partner_id[0] : 0,
      customerName: p.partner_id ? p.partner_id[1] : 'Unknown',
      scheduledDate: p.scheduled_date,
      originOrder: p.origin,
      moveIds: p.move_ids,
      writeDate: p.write_date,
    }));

    const lastPicking = pickings[pickings.length - 1];
    const nextCursor =
      pickings.length === 100 && lastPicking
        ? lastPicking.write_date
        : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async disconnect(_credentials: ErpSecretPayload): Promise<void> {
    this.logger.log(`Disconnecting Odoo`);
    void _credentials;
    // API Keys se revocan desde la UI de Odoo; no hay endpoint programático estándar
  }
}
