import { Injectable, Logger } from '@nestjs/common';
import type {
  ErpConnector,
  ErpCapability,
  SyncPage,
} from '../interfaces/erp-connector.interface.js';

// Bind ERP (México) — P0.
// Autenticación: Authorization: Bearer <API_KEY>.
// URL base documentada: https://api.bind.com.mx.
// Límites: hasta 150 solicitudes/5 min y 5,000/24 h sin suscripción de desarrollador.
@Injectable()
export class BindAdapter implements ErpConnector {
  readonly provider = 'bind';
  private readonly logger = new Logger(BindAdapter.name);

  async verifyConnection(connectionId: string) {
    // La validación real de credenciales ocurre en el servicio de integraciones
    // que recupera la clave cifrada de ErpSecret y llama al endpoint mínimo.
    this.logger.log(`Verifying Bind connection ${connectionId}`);
    return {
      externalTenantId: `bind_${connectionId}`,
      capabilities: [
        'customers',
        'sales_orders',
        'invoices',
      ] as ErpCapability[],
    };
  }

  async pullSalesOrders(
    connectionId: string,
    cursor?: string,
  ): Promise<SyncPage> {
    this.logger.log(
      `Pulling Bind sales orders for ${connectionId}, cursor=${cursor ?? 'none'}`,
    );
    // Implementación real contra https://api.bind.com.mx/api/Orders u similar
    // debe confirmarse en el catálogo de endpoints de Bind antes de producción.
    return { records: [], nextCursor: undefined };
  }

  async pullInvoices(connectionId: string, cursor?: string): Promise<SyncPage> {
    this.logger.log(
      `Pulling Bind invoices for ${connectionId}, cursor=${cursor ?? 'none'}`,
    );
    return { records: [], nextCursor: undefined };
  }

  async disconnect(connectionId: string): Promise<void> {
    this.logger.log(`Disconnecting Bind ${connectionId}`);
  }
}
