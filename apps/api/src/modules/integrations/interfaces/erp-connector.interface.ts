export type ErpCapability =
  | 'customers'
  | 'sales_orders'
  | 'invoices'
  | 'payments'
  | 'refunds'
  | 'shipments'
  | 'documents';

/**
 * Payload de credenciales ERP desencriptado.
 * Cada adapter recibe esto para autenticarse contra su API.
 */
export interface ErpSecretPayload {
  apiKey: string; // Clave principal (API Key, username, etc.)
  baseUrl?: string; // URL base de la instancia (Odoo, ERPNext)
  // Campos específicos por provider
  subscriptionKey?: string; // Bind ERP: clave de suscripción opcional
  username?: string; // Siigo: username
  accessKey?: string; // Siigo: access key
  accessToken?: string; // Siigo/ERPNext: OAuth access token (cached)
  tokenExpiresAt?: string; // Siigo/ERPNext: expiración token (cached)
  apiSecret?: string; // ERPNext/Odoo: API Secret
  database?: string; // Odoo: nombre de la base de datos
}

export interface ErpConnector {
  provider: string;

  /**
   * Verifica que las credenciales funcionen y devuelve el tenant externo y capacidades.
   */
  verifyConnection(credentials: ErpSecretPayload): Promise<{
    externalTenantId: string;
    capabilities: ErpCapability[];
  }>;

  /**
   * Sincroniza ventas/pedidos desde el ERP con paginación incremental.
   */
  pullSalesOrders(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<{
    records: unknown[];
    nextCursor?: string;
    sourceUpdatedAt?: string;
  }>;

  /**
   * Sincroniza facturas desde el ERP.
   */
  pullInvoices(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<{
    records: unknown[];
    nextCursor?: string;
    sourceUpdatedAt?: string;
  }>;

  /**
   * Sincroniza pagos/cobros registrados en el ERP (opcional).
   */
  pullPayments?(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<{
    records: unknown[];
    nextCursor?: string;
    sourceUpdatedAt?: string;
  }>;

  /**
   * Sincroniza envíos/guías de transporte (opcional).
   */
  pullShipments?(
    credentials: ErpSecretPayload,
    cursor?: string,
  ): Promise<{
    records: unknown[];
    nextCursor?: string;
    sourceUpdatedAt?: string;
  }>;

  /**
   * Desconecta y revoca acceso.
   */
  disconnect(credentials: ErpSecretPayload): Promise<void>;
}

export interface SyncPage {
  records: unknown[];
  nextCursor?: string;
  sourceUpdatedAt?: string;
}
