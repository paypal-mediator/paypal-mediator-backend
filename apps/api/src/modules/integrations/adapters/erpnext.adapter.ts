import { Injectable, Logger } from '@nestjs/common';
import type {
  ErpConnector,
  ErpCapability,
  SyncPage,
  ErpSecretPayload,
} from '../interfaces/erp-connector.interface.js';

// ERPNext / Frappe — P1.
// Autenticación: Token (API Key:API Secret) o Bearer OAuth.
// Base URL: https://<tu-instancia>.erpnext.com/api
// Doctypes: Customer, Sales Order, Sales Invoice, Payment Entry, Delivery Note
@Injectable()
export class ErpNextAdapter implements ErpConnector {
  readonly provider = 'erpnext';
  private readonly logger = new Logger(ErpNextAdapter.name);

  private getBaseUrl(credentials: ErpSecretPayload): string {
    if (!credentials.baseUrl) {
      throw new Error(
        'ERPNext baseUrl required (ej: https://miempresa.erpnext.com)',
      );
    }
    return credentials.baseUrl.replace(/\/$/, '') + '/api';
  }

  private getHeaders(credentials: ErpSecretPayload): HeadersInit {
    if (credentials.apiKey && credentials.apiSecret) {
      // Token auth: "token api_key:api_secret"
      return {
        Authorization: `token ${credentials.apiKey}:${credentials.apiSecret}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
    }
    if (credentials.accessToken) {
      // OAuth Bearer token
      return {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
    }
    throw new Error(
      'ERPNext credentials required: apiKey+apiSecret OR accessToken',
    );
  }

  private async request<T>(
    path: string,
    credentials: ErpSecretPayload,
    params?: URLSearchParams,
  ): Promise<T> {
    const url = new URL(`${this.getBaseUrl(credentials)}${path}`);
    if (params) url.search = params.toString();

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.getHeaders(credentials),
      redirect: 'error',
    });

    if (response.status === 401 && credentials.accessToken) {
      // Token expirado - en implementación real, refrescar con refresh_token
      throw new Error(
        'ERPNext access token expired; re-authenticate via OAuth',
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`ERPNext API ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async verifyConnection(credentials: ErpSecretPayload) {
    this.logger.log(`Verifying ERPNext connection`);
    // Verificar obteniendo usuario actual
    const user = await this.request<{ message: string }>(
      '/method/frappe.auth.get_logged_user',
      credentials,
    );
    return {
      externalTenantId: `erpnext_${user.message}`,
      capabilities: [
        'customers',
        'sales_orders',
        'invoices',
        'shipments',
        'payments',
      ] as ErpCapability[],
    };
  }

  private buildFilters(cursor?: string): string[][] {
    const filters: string[][] = [['docstatus', '=', '1']]; // Solo documentos enviados
    if (cursor) {
      filters.push(['modified', '>', cursor]);
    }
    return filters;
  }

  async pullSalesOrders(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(`Pulling ERPNext Sales Orders, cursor=${cursor ?? 'none'}`);
    const params = new URLSearchParams();
    params.set(
      'fields',
      JSON.stringify([
        'name',
        'customer',
        'customer_name',
        'transaction_date',
        'grand_total',
        'currency',
        'status',
        'items',
        'modified',
      ]),
    );
    params.set('filters', JSON.stringify(this.buildFilters(cursor)));
    params.set('order_by', 'modified asc');
    params.set('limit_page_length', '100');

    const data = await this.request<{
      data: Array<{
        name: string;
        customer: string;
        customer_name: string;
        transaction_date: string;
        grand_total: number;
        currency: string;
        status: string;
        items: Array<{
          item_code: string;
          item_name: string;
          qty: number;
          rate: number;
        }>;
        modified: string;
      }>;
    }>('/resource/Sales Order', credentials, params);

    const records = (data.data ?? []).map((so) => ({
      externalId: so.name,
      orderNumber: so.name,
      customerId: so.customer,
      customerName: so.customer_name,
      orderedAt: so.transaction_date,
      amount: so.grand_total.toString(),
      currency: so.currency,
      status: so.status,
      items: so.items,
      modified: so.modified,
    }));

    const lastRecord = records[records.length - 1];
    const nextCursor =
      records.length === 100 && lastRecord ? lastRecord.modified : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullInvoices(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling ERPNext Sales Invoices, cursor=${cursor ?? 'none'}`,
    );
    const params = new URLSearchParams();
    params.set(
      'fields',
      JSON.stringify([
        'name',
        'customer',
        'customer_name',
        'posting_date',
        'grand_total',
        'currency',
        'status',
        'items',
        'payments',
        'modified',
        'is_return',
      ]),
    );
    const filters = this.buildFilters(cursor);
    filters.push(['is_return', '=', '0']); // Excluir notas de crédito
    params.set('filters', JSON.stringify(filters));
    params.set('order_by', 'modified asc');
    params.set('limit_page_length', '100');

    const data = await this.request<{
      data: Array<{
        name: string;
        customer: string;
        customer_name: string;
        posting_date: string;
        grand_total: number;
        currency: string;
        status: string;
        items: Array<{
          item_code: string;
          item_name: string;
          qty: number;
          rate: number;
        }>;
        payments: Array<{
          mode_of_payment: string;
          amount: number;
          reference_name: string;
        }>;
        modified: string;
        is_return: number;
      }>;
    }>('/resource/Sales Invoice', credentials, params);

    const records = (data.data ?? []).map((inv) => ({
      externalId: inv.name,
      invoiceNumber: inv.name,
      customerId: inv.customer,
      customerName: inv.customer_name,
      date: inv.posting_date,
      amount: inv.grand_total.toString(),
      currency: inv.currency,
      status: inv.status,
      items: inv.items,
      payments: inv.payments,
      modified: inv.modified,
    }));

    const lastRecord = records[records.length - 1];
    const nextCursor =
      records.length === 100 && lastRecord ? lastRecord.modified : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullPayments(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling ERPNext Payment Entries, cursor=${cursor ?? 'none'}`,
    );
    const params = new URLSearchParams();
    params.set(
      'fields',
      JSON.stringify([
        'name',
        'party',
        'party_name',
        'posting_date',
        'paid_amount',
        'currency',
        'mode_of_payment',
        'references',
        'modified',
      ]),
    );
    const filters = this.buildFilters(cursor);
    filters.push(['party_type', '=', 'Customer']);
    params.set('filters', JSON.stringify(filters));
    params.set('order_by', 'modified asc');
    params.set('limit_page_length', '100');

    const data = await this.request<{
      data: Array<{
        name: string;
        party: string;
        party_name: string;
        posting_date: string;
        paid_amount: number;
        currency: string;
        mode_of_payment: string;
        references: Array<{ reference_name: string; allocated_amount: number }>;
        modified: string;
      }>;
    }>('/resource/Payment Entry', credentials, params);

    const records = (data.data ?? []).map((pe) => ({
      externalId: pe.name,
      paymentNumber: pe.name,
      customerId: pe.party,
      customerName: pe.party_name,
      date: pe.posting_date,
      amount: pe.paid_amount.toString(),
      currency: pe.currency,
      mode: pe.mode_of_payment,
      references: pe.references,
      modified: pe.modified,
    }));

    const lastRecord = records[records.length - 1];
    const nextCursor =
      records.length === 100 && lastRecord ? lastRecord.modified : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullShipments(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling ERPNext Delivery Notes, cursor=${cursor ?? 'none'}`,
    );
    const params = new URLSearchParams();
    params.set(
      'fields',
      JSON.stringify([
        'name',
        'customer',
        'customer_name',
        'posting_date',
        'items',
        'against_sales_order',
        'modified',
      ]),
    );
    const filters = this.buildFilters(cursor);
    params.set('filters', JSON.stringify(filters));
    params.set('order_by', 'modified asc');
    params.set('limit_page_length', '100');

    const data = await this.request<{
      data: Array<{
        name: string;
        customer: string;
        customer_name: string;
        posting_date: string;
        items: Array<{
          item_code: string;
          item_name: string;
          qty: number;
          against_sales_order: string;
        }>;
        against_sales_order: string;
        modified: string;
      }>;
    }>('/resource/Delivery Note', credentials, params);

    const records = (data.data ?? []).map((dn) => ({
      externalId: dn.name,
      deliveryNoteNumber: dn.name,
      customerId: dn.customer,
      customerName: dn.customer_name,
      date: dn.posting_date,
      items: dn.items,
      againstSalesOrder: dn.against_sales_order,
      modified: dn.modified,
    }));

    const lastRecord = records[records.length - 1];
    const nextCursor =
      records.length === 100 && lastRecord ? lastRecord.modified : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async disconnect(_credentials: ErpSecretPayload): Promise<void> {
    this.logger.log(`Disconnecting ERPNext`);
    void _credentials;
    // Revocar API Key/Secret desde la UI de Frappe; no hay endpoint estándar
  }
}
