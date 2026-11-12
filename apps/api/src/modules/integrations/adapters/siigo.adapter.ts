import { Injectable, Logger } from '@nestjs/common';
import type {
  ErpConnector,
  ErpCapability,
  SyncPage,
  ErpSecretPayload,
} from '../interfaces/erp-connector.interface.js';

// Siigo Nube México — P0.
// Autenticación: OAuth 2.0 Client Credentials → access_token (24h).
// Base URL: https://api.siigo.mx/v1
// Endpoints: /customers, /invoices, /vouchers, /payment-receipts, /products
@Injectable()
export class SiigoAdapter implements ErpConnector {
  readonly provider = 'siigo-mx';
  private readonly logger = new Logger(SiigoAdapter.name);
  private readonly baseUrl = 'https://api.siigo.mx/v1';
  private readonly authUrl = 'https://api.siigo.mx/auth';

  private accessTokenCache: { token: string; expiresAt: number } | null = null;

  private async getAccessToken(credentials: ErpSecretPayload): Promise<string> {
    // Usar token cacheado si es válido (> 5 min de margen)
    if (
      this.accessTokenCache &&
      Date.now() < this.accessTokenCache.expiresAt - 5 * 60 * 1000
    ) {
      return this.accessTokenCache.token;
    }

    if (!credentials.username || !credentials.accessKey) {
      throw new Error(
        'Siigo credentials missing: username and accessKey required',
      );
    }

    const response = await fetch(this.authUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        username: credentials.username,
        access_key: credentials.accessKey,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Siigo auth failed ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number; // segundos (86400 = 24h)
      token_type: 'Bearer';
    };

    this.accessTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return data.access_token;
  }

  private async request<T>(
    path: string,
    credentials: ErpSecretPayload,
    params?: URLSearchParams,
  ): Promise<T> {
    const token = await this.getAccessToken(credentials);
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) url.search = params.toString();

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'SiigoAPI-Application-Id': 'PayPalAudito', // Identificador de la app
        Accept: 'application/json',
      },
      redirect: 'error',
    });

    if (response.status === 401) {
      // Token expirado, limpiar cache y reintentar una vez
      this.accessTokenCache = null;
      const newToken = await this.getAccessToken(credentials);
      const retryResponse = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${newToken}`,
          'SiigoAPI-Application-Id': 'PayPalAudito',
          Accept: 'application/json',
        },
      });
      if (!retryResponse.ok) {
        const text = await retryResponse.text().catch(() => '');
        throw new Error(`Siigo API ${retryResponse.status}: ${text}`);
      }
      return retryResponse.json() as Promise<T>;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Siigo API ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async verifyConnection(credentials: ErpSecretPayload) {
    this.logger.log(`Verifying Siigo connection`);
    // Validar obteniendo access token y consultando un endpoint ligero
    await this.getAccessToken(credentials);
    await this.request<{ items: unknown[] }>(
      '/invoices',
      credentials,
      new URLSearchParams({ page_size: '1' }),
    );
    return {
      externalTenantId: `siigo_${credentials.username}`,
      capabilities: [
        'customers',
        'sales_orders',
        'invoices',
        'payments',
      ] as ErpCapability[],
    };
  }

  async pullSalesOrders(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling Siigo quotations (sales orders), cursor=${cursor ?? 'none'}`,
    );
    // Siigo no tiene "sales orders" directo; usamos quotations como proxy
    const params = new URLSearchParams();
    if (cursor) params.set('page', cursor);
    params.set('page_size', '100');

    const data = await this.request<{
      pagination: { page: number; page_size: number; total_results: number };
      results: Array<{
        id: string;
        number: number;
        date: string;
        customer: { identification: string; name: string };
        items: Array<{
          code: string;
          description: string;
          quantity: number;
          price: number;
        }>;
        total: number;
        currency: { code: string };
      }>;
    }>('/quotations', credentials, params);

    const records = (data.results ?? []).map((q) => ({
      externalId: q.id,
      orderNumber: q.number.toString(),
      orderedAt: q.date,
      customerId: q.customer.identification,
      customerName: q.customer.name,
      amount: q.total.toString(),
      currency: q.currency.code,
      items: q.items,
    }));

    const nextCursor =
      data.pagination.page <
      Math.ceil(data.pagination.total_results / data.pagination.page_size)
        ? String(data.pagination.page + 1)
        : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullInvoices(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(`Pulling Siigo invoices, cursor=${cursor ?? 'none'}`);
    const params = new URLSearchParams();
    if (cursor) params.set('page', cursor);
    params.set('page_size', '100');

    const data = await this.request<{
      pagination: { page: number; page_size: number; total_results: number };
      results: Array<{
        id: string;
        document: { id: number; name: string };
        prefix: string;
        number: number;
        name: string; // ej: FV-003-457
        date: string;
        customer: {
          identification: string;
          branch_office: number;
          name: string;
        };
        seller: number;
        items: Array<{
          id: string;
          code: string;
          description: string;
          quantity: number;
          price: number;
          discount: { percentage: number; value: number };
          taxes: Array<{
            id: number;
            name: string;
            percentage: number;
            value: number;
          }>;
        }>;
        total: number;
        balance: number;
        payments: Array<{
          id: number;
          name: string;
          value: number;
          due_date: string;
        }>;
        currency: { code: string; exchange_rate: number };
        stamp: { status: string; cufe: string; cude: string };
      }>;
    }>('/invoices', credentials, params);

    const records = (data.results ?? []).map((inv) => ({
      externalId: inv.id,
      invoiceNumber: inv.name,
      documentType: inv.document.name,
      number: inv.number,
      prefix: inv.prefix,
      date: inv.date,
      customerId: inv.customer.identification,
      customerName: inv.customer.name,
      customerBranchOffice: inv.customer.branch_office,
      seller: inv.seller,
      amount: inv.total.toString(),
      balance: inv.balance.toString(),
      currency: inv.currency.code,
      exchangeRate: inv.currency.exchange_rate,
      items: inv.items,
      payments: inv.payments,
      stamp: inv.stamp,
    }));

    const nextCursor =
      data.pagination.page <
      Math.ceil(data.pagination.total_results / data.pagination.page_size)
        ? String(data.pagination.page + 1)
        : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullPayments(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling Siigo payments (vouchers), cursor=${cursor ?? 'none'}`,
    );
    const params = new URLSearchParams();
    if (cursor) params.set('page', cursor);
    params.set('page_size', '100');

    const data = await this.request<{
      pagination: { page: number; page_size: number; total_results: number };
      results: Array<{
        id: string;
        date: string;
        customer: { identification: string; name: string };
        value: number;
        payment_method: string;
        invoice: { prefix: string; number: number };
      }>;
    }>('/vouchers', credentials, params);

    const records = (data.results ?? []).map((v) => ({
      externalId: v.id,
      date: v.date,
      customerId: v.customer.identification,
      customerName: v.customer.name,
      amount: v.value.toString(),
      method: v.payment_method,
      invoiceRef: `${v.invoice.prefix}-${v.invoice.number}`,
    }));

    const nextCursor =
      data.pagination.page <
      Math.ceil(data.pagination.total_results / data.pagination.page_size)
        ? String(data.pagination.page + 1)
        : undefined;

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullShipments(
    _credentials: ErpSecretPayload,
    _cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling Siigo shipments - not directly supported, returning empty`,
    );
    void _credentials;
    void _cursor;
    // Siigo México no expone shipments/guías directamente via API
    // Se podría usar delivery notes si están disponibles en el futuro
    return { records: [], nextCursor: undefined };
  }

  async disconnect(_credentials: ErpSecretPayload): Promise<void> {
    this.logger.log(`Disconnecting Siigo`);
    void _credentials;
    this.accessTokenCache = null;
    // No hay endpoint de revocación; el token expira solo en 24h
  }
}
