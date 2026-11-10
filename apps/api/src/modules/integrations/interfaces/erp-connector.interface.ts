export type ErpCapability =
  | 'customers'
  | 'sales_orders'
  | 'invoices'
  | 'payments'
  | 'refunds'
  | 'shipments'
  | 'documents';

export interface ErpConnector {
  provider: string;

  /**
   * Verifica que las credenciales funcionen y devuelve el tenant externo y capacidades.
   */
  verifyConnection(connectionId: string): Promise<{
    externalTenantId: string;
    capabilities: ErpCapability[];
  }>;

  /**
   * Sincroniza ventas/pedidos desde el ERP con paginación incremental.
   */
  pullSalesOrders(
    connectionId: string,
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
    connectionId: string,
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
    connectionId: string,
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
    connectionId: string,
    cursor?: string,
  ): Promise<{
    records: unknown[];
    nextCursor?: string;
    sourceUpdatedAt?: string;
  }>;

  /**
   * Desconecta y revoca acceso.
   */
  disconnect(connectionId: string): Promise<void>;
}

export interface SyncPage {
  records: unknown[];
  nextCursor?: string;
  sourceUpdatedAt?: string;
}
