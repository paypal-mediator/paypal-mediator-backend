import { Injectable, Logger } from '@nestjs/common';
import type {
  ErpConnector,
  ErpCapability,
  SyncPage,
  ErpSecretPayload,
} from '../interfaces/erp-connector.interface.js';

// Bind ERP (México) — P0.
// Autenticación: Authorization: Bearer <API_KEY>.
// Opcional: Ocp-Apim-Subscription-Key para límites más altos.
// URL base: https://api.bind.com.mx.
// Límites: 150 req/5min, 5,000 req/24h (sin suscripción); 300/5min, 10,000/24h (registrado).
@Injectable()
export class BindAdapter implements ErpConnector {
  readonly provider = 'bind';
  private readonly logger = new Logger(BindAdapter.name);
  private readonly baseUrl = 'https://api.bind.com.mx';

  private buildHeaders(credentials: ErpSecretPayload): HeadersInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.apiKey}`,
      Accept: 'application/json',
    };
    if (credentials.subscriptionKey) {
      headers['Ocp-Apim-Subscription-Key'] = credentials.subscriptionKey;
    }
    return headers;
  }

  private async request<T>(
    path: string,
    credentials: ErpSecretPayload,
    params?: URLSearchParams,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) url.search = params.toString();

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.buildHeaders(credentials),
      redirect: 'error',
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Bind API ${response.status}: ${text || response.statusText}`,
      );
    }
    return response.json() as Promise<T>;
  }

  async verifyConnection(credentials: ErpSecretPayload) {
    this.logger.log(`Verifying Bind connection`);
    // Llamada ligera para validar credenciales: obtener perfil de usuario
    const data = await this.request<{ ID: string }>(
      '/api/UserProfile',
      credentials,
    );
    return {
      externalTenantId: data.ID ?? `bind_${credentials.apiKey.slice(0, 8)}`,
      capabilities: [
        'customers',
        'sales_orders',
        'invoices',
      ] as ErpCapability[],
    };
  }

  async pullSalesOrders(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(`Pulling Bind sales orders, cursor=${cursor ?? 'none'}`);
    const params = new URLSearchParams();
    if (cursor) params.set('$skiptoken', cursor); // OData pagination token
    params.set('$top', '100');

    // Bind usa OData: /api/Orders?$top=100&$skiptoken=...
    const data = await this.request<{
      value: Array<{
        ID: string;
        Code: string;
        Date: string;
        CustomerID: string;
        CustomerName: string;
        TotalAmount: number;
        Currency: string;
        Status: string;
        Items: Array<{
          ProductID: string;
          Quantity: number;
          UnitPrice: number;
        }>;
      }>;
      nextLink?: string;
      count?: number;
    }>('/api/Orders', credentials, params);

    const records = (data.value ?? []).map((order) => ({
      externalId: order.ID,
      orderNumber: order.Code,
      orderedAt: order.Date,
      customerId: order.CustomerID,
      customerName: order.CustomerName,
      amount: order.TotalAmount.toString(),
      currency: order.Currency,
      status: order.Status,
      items: order.Items,
    }));

    // Extraer cursor del nextLink (OData)
    let nextCursor: string | undefined;
    if (data.nextLink) {
      const nextUrl = new URL(data.nextLink);
      nextCursor = nextUrl.searchParams.get('$skiptoken') ?? undefined;
    }

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullInvoices(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(`Pulling Bind invoices, cursor=${cursor ?? 'none'}`);
    const params = new URLSearchParams();
    if (cursor) params.set('$skiptoken', cursor);
    params.set('$top', '100');

    const data = await this.request<{
      value: Array<{
        ID: string;
        Code: string;
        Number: string;
        Date: string;
        CustomerID: string;
        CustomerName: string;
        TotalAmount: number;
        Currency: string;
        Status: string;
        Items: Array<{
          ProductID: string;
          Quantity: number;
          UnitPrice: number;
        }>;
      }>;
      nextLink?: string;
    }>('/api/Invoices', credentials, params);

    const records = (data.value ?? []).map((inv) => ({
      externalId: inv.ID,
      invoiceNumber: inv.Number,
      invoiceCode: inv.Code,
      date: inv.Date,
      customerId: inv.CustomerID,
      customerName: inv.CustomerName,
      amount: inv.TotalAmount.toString(),
      currency: inv.Currency,
      status: inv.Status,
      items: inv.Items,
    }));

    let nextCursor: string | undefined;
    if (data.nextLink) {
      const nextUrl = new URL(data.nextLink);
      nextCursor = nextUrl.searchParams.get('$skiptoken') ?? undefined;
    }

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async pullShipments(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling Bind shipments (inventory movements), cursor=${cursor ?? 'none'}`,
    );
    // Bind no tiene endpoint directo de shipments; usamos Inventory movements como proxy
    const params = new URLSearchParams();
    if (cursor) params.set('$skiptoken', cursor);
    params.set('$top', '100');
    params.set('$filter', "Type eq 'Shipment'"); // Filtrar movimientos de salida

    const data = await this.request<{
      value: Array<{
        ID: string;
        Date: string;
        WarehouseID: string;
        Items: Array<{ ProductID: string; Quantity: number }>;
        Reference: string; // Order/Invoice reference
      }>;
      nextLink?: string;
    }>('/api/Inventory', credentials, params);

    const records = (data.value ?? []).map((mov) => ({
      externalId: mov.ID,
      date: mov.Date,
      warehouseId: mov.WarehouseID,
      reference: mov.Reference,
      items: mov.Items,
    }));

    let nextCursor: string | undefined;
    if (data.nextLink) {
      const nextUrl = new URL(data.nextLink);
      nextCursor = nextUrl.searchParams.get('$skiptoken') ?? undefined;
    }

    return { records, nextCursor, sourceUpdatedAt: new Date().toISOString() };
  }

  async disconnect(_credentials: ErpSecretPayload): Promise<void> {
    this.logger.log(`Disconnecting Bind`);
    void _credentials;
    // Bind no tiene endpoint de revocación; el API Key se invalida en su portal
  }
}
