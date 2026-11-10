import { Injectable, Logger } from '@nestjs/common';
import type {
  ErpConnector,
  ErpCapability,
  SyncPage,
} from '../interfaces/erp-connector.interface.js';

// MockERP — Fixture explícitamente etiquetado DEMO / MOCK para pruebas de
// disputas sin credenciales reales. Nunca usar en producción.
@Injectable()
export class MockErpAdapter implements ErpConnector {
  readonly provider = 'mock-erp';
  private readonly logger = new Logger(MockErpAdapter.name);

  async verifyConnection(connectionId: string) {
    this.logger.log(`MockERP verify ${connectionId}`);
    return {
      externalTenantId: 'mock-erp-tenant',
      capabilities: [
        'customers',
        'sales_orders',
        'invoices',
        'shipments',
      ] as ErpCapability[],
    };
  }

  async pullSalesOrders(): Promise<SyncPage> {
    this.logger.log('MockERP pullSalesOrders');
    return {
      records: [
        {
          externalId: 'MOCK_ORDER_001',
          invoiceNumber: 'FAC-2026-00124',
          amount: '1299.00',
          currency: 'MXN',
          customerName: 'Cliente Demo',
          orderedAt: '2026-11-01T10:00:00Z',
          status: 'PAID',
        },
      ],
      nextCursor: undefined,
    };
  }

  async pullInvoices(): Promise<SyncPage> {
    this.logger.log('MockERP pullInvoices');
    return {
      records: [
        {
          externalId: 'MOCK_INVOICE_001',
          invoiceNumber: 'FAC-2026-00124',
          amount: '1299.00',
          currency: 'MXN',
          status: 'ISSUED',
        },
      ],
      nextCursor: undefined,
    };
  }

  async pullShipments(): Promise<SyncPage> {
    this.logger.log('MockERP pullShipments');
    return {
      records: [],
      nextCursor: undefined,
    };
  }

  async disconnect(connectionId: string): Promise<void> {
    this.logger.log(`MockERP disconnect ${connectionId}`);
  }
}
