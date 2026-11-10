import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Environment } from '../../common/config/environment.js';
import { ENVIRONMENT } from '../../common/config/environment.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { AuditService } from '../monitoring/audit.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import type {
  ErpProvider,
  ErpCapability,
  MatchMethod,
  Confidence,
} from '@resolve-ai/contracts';
import { BindAdapter } from './adapters/bind.adapter.js';
import { MockErpAdapter } from './adapters/mock-erp.adapter.js';
import type { ErpConnector } from './interfaces/erp-connector.interface.js';
import { contentHash } from '../../common/data/content-hash.js';

const SYSTEM_MERCHANT_ID = '00000000-0000-0000-0000-000000000000';

const CATALOG: Array<{
  provider: ErpProvider;
  name: string;
  segment: string;
  integrationType: 'oauth' | 'api_key' | 'local_agent';
  connectionExperience: string;
  capabilities: ErpCapability[];
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  authUrl?: string;
}> = [
  {
    provider: 'bind',
    name: 'Bind ERP',
    segment: 'Pequeña / mediana, México',
    integrationType: 'api_key',
    connectionExperience: 'Copiar API Key en configuración',
    capabilities: ['customers', 'sales_orders', 'invoices'],
    priority: 'P0',
  },
  {
    provider: 'siigo-mx',
    name: 'Siigo Nube México',
    segment: 'Pequeña, México',
    integrationType: 'api_key',
    connectionExperience: 'Generar credenciales API',
    capabilities: ['customers', 'sales_orders', 'invoices', 'payments'],
    priority: 'P0',
  },
  {
    provider: 'odoo',
    name: 'Odoo',
    segment: 'Pequeña / mediana',
    integrationType: 'api_key',
    connectionExperience: 'URL de instancia + API Key',
    capabilities: ['customers', 'sales_orders', 'invoices', 'shipments'],
    priority: 'P0',
  },
  {
    provider: 'mock-erp',
    name: 'MockERP (DEMO / MOCK)',
    segment: 'Pruebas sin credenciales',
    integrationType: 'api_key',
    connectionExperience: 'Fixture etiquetado DEMO / MOCK',
    capabilities: ['customers', 'sales_orders', 'invoices', 'shipments'],
    priority: 'P0',
    authUrl: undefined,
  },
];

const ADAPTERS: Record<string, ErpConnector> = {
  bind: new BindAdapter(),
  'mock-erp': new MockErpAdapter(),
};

@Injectable()
export class IntegrationsService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  async onModuleInit() {
    await this.jobs.connect();
    this.jobs.registerHandler('ERP_SYNC', async (data) => {
      await this.processErpSync(
        data as {
          connectionId: string;
          merchantId: string;
          provider: ErpProvider;
          resource: string;
          cursor: string | null;
        },
      );
    });
    this.logger.log('Registered ERP_SYNC job handler');
  }

  async onModuleDestroy() {
    await this.jobs.disconnect();
  }

  getCatalog() {
    return {
      items: CATALOG.map((c) => ({
        provider: c.provider,
        name: c.name,
        segment: c.segment,
        integrationType: c.integrationType,
        connectionExperience: c.connectionExperience,
        capabilities: c.capabilities,
        priority: c.priority,
        authUrl: c.authUrl,
      })),
    };
  }

  async listConnections(merchantId: string) {
    const connections = await this.prisma.erpConnection.findMany({
      where: { merchantId },
      include: { secret: { select: { keyVersion: true, rotatedAt: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      items: connections.map((c) => ({
        id: c.id,
        merchantId: c.merchantId,
        provider: c.provider,
        externalTenantId: c.externalTenantId,
        baseUrl: c.baseUrl,
        status: c.status,
        scopes: c.scopes,
        lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
        lastSyncError: c.lastSyncError,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
      total: connections.length,
    };
  }

  async getConnectionStatus(merchantId: string, connectionId: string) {
    const connection = await this.prisma.erpConnection.findFirst({
      where: { id: connectionId, merchantId },
    });
    if (!connection) {
      throw new Error('CONNECTION_NOT_FOUND');
    }
    const adapter = ADAPTERS[connection.provider];
    const capabilities = adapter
      ? (await adapter.verifyConnection(connectionId)).capabilities
      : [];
    return {
      connectionId: connection.id,
      provider: connection.provider,
      status: connection.status,
      externalTenantId: connection.externalTenantId,
      capabilities,
      lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
      lastSyncError: connection.lastSyncError,
    };
  }

  async connectWithKey(
    merchantId: string,
    provider: ErpProvider,
    apiKey: string,
    baseUrl?: string,
  ) {
    const adapter = ADAPTERS[provider];
    if (!adapter) {
      throw new Error('UNSUPPORTED_PROVIDER');
    }

    // Verificación mínima de conexión antes de persistir.
    const tempConnectionId = `temp-${crypto.randomUUID()}`;
    try {
      await adapter.verifyConnection(tempConnectionId);
    } catch (error) {
      this.logger.warn(
        `Connection verification failed for ${provider}: ${String(error)}`,
      );
      throw new Error('CONNECTION_VERIFICATION_FAILED', { cause: error });
    }

    const connection = await this.prisma.erpConnection.create({
      data: {
        merchantId,
        provider,
        externalTenantId: null,
        baseUrl,
        status: 'connected',
        scopes: null,
        lastSyncAt: null,
        lastSyncError: null,
        secret: {
          create: {
            encryptedPayload: apiKey, // En producción, cifrar con KMS/vault antes de guardar.
            keyVersion: 1,
          },
        },
      },
    });

    await this.audit.append({
      merchantId,
      actorUserId: null,
      actorKind: 'SYSTEM',
      resourceType: 'MERCHANT',
      resourceId: connection.id,
      outcome: 'SUCCEEDED',
      record: {
        action: 'PAYPAL_CONNECTION_CHECKED',
        details: {},
      },
    });

    return {
      id: connection.id,
      merchantId: connection.merchantId,
      provider: connection.provider,
      status: connection.status,
    };
  }

  async disconnect(merchantId: string, connectionId: string) {
    const connection = await this.prisma.erpConnection.findFirst({
      where: { id: connectionId, merchantId },
    });
    if (!connection) {
      throw new Error('CONNECTION_NOT_FOUND');
    }

    const adapter = ADAPTERS[connection.provider];
    if (adapter) {
      try {
        await adapter.disconnect(connectionId);
      } catch {
        // No fallar la desconexión si el adaptador falla.
      }
    }

    await this.prisma.erpConnection.delete({ where: { id: connectionId } });

    await this.audit.append({
      merchantId,
      actorUserId: null,
      actorKind: 'SYSTEM',
      resourceType: 'MERCHANT',
      resourceId: connectionId,
      outcome: 'SUCCEEDED',
      record: {
        action: 'PAYPAL_CONNECTION_CHECKED',
        details: {},
      },
    });

    return { ok: true };
  }

  async sync(merchantId: string, connectionId: string, resource?: string) {
    const connection = await this.prisma.erpConnection.findFirst({
      where: { id: connectionId, merchantId },
    });
    if (!connection) {
      throw new Error('CONNECTION_NOT_FOUND');
    }

    if (connection.status !== 'connected') {
      throw new Error('CONNECTION_NOT_READY');
    }

    const adapter = ADAPTERS[connection.provider];
    if (!adapter) {
      throw new Error('UNSUPPORTED_PROVIDER');
    }

    const validResources = [
      'customers',
      'sales_orders',
      'invoices',
      'payments',
      'shipments',
      'documents',
    ] as const;
    const resources: Array<(typeof validResources)[number]> = resource
      ? validResources.includes(resource as (typeof validResources)[number])
        ? [resource as (typeof validResources)[number]]
        : ['sales_orders', 'invoices', 'shipments']
      : ['sales_orders', 'invoices', 'shipments'];

    for (const res of resources) {
      // Encolar job de sincronización en pg-boss para procesamiento asíncrono.
      if (this.jobs.isConnected()) {
        await this.jobs.enqueue(
          'ERP_SYNC',
          {
            connectionId,
            merchantId,
            provider: connection.provider,
            resource: res,
            cursor: null,
          },
          { retries: 3, delay: 0 },
        );
      }
    }

    await this.prisma.erpConnection.update({
      where: { id: connectionId },
      data: { status: 'syncing' },
    });

    return { ok: true, connectionId, resources };
  }

  async linkTransaction(
    merchantId: string,
    paypalCaptureId: string,
    recordId: string,
    matchMethod: MatchMethod,
    confidence: Confidence,
  ) {
    const record = await this.prisma.externalRecord.findFirst({
      where: { id: recordId, merchantId },
    });
    if (!record) {
      throw new Error('RECORD_NOT_FOUND');
    }

    const link = await this.prisma.transactionLink.create({
      data: {
        merchantId,
        paypalCaptureId,
        recordId,
        matchMethod,
        confidence,
        reviewedBy: null,
      },
    });

    await this.audit.append({
      merchantId,
      actorUserId: null,
      actorKind: 'SYSTEM',
      resourceType: 'MERCHANT',
      resourceId: link.id,
      outcome: 'SUCCEEDED',
      record: {
        action: 'INGESTION_FINISHED',
        details: {},
      },
    });

    return link;
  }

  async getLinkedRecords(merchantId: string, paypalCaptureId: string) {
    const links = await this.prisma.transactionLink.findMany({
      where: { merchantId, paypalCaptureId },
      include: { record: true },
    });
    return {
      items: links.map((l) => ({
        id: l.id,
        merchantId: l.merchantId,
        paypalCaptureId: l.paypalCaptureId,
        paypalOrderId: l.paypalOrderId,
        recordId: l.recordId,
        matchMethod: l.matchMethod,
        confidence: l.confidence,
        reviewedBy: l.reviewedBy,
        createdAt: l.createdAt.toISOString(),
      })),
      total: links.length,
    };
  }

  /**
   * Procesa un job de sincronización ERP encolado en pg-boss.
   * Extrae registros del adaptador, los normaliza y guarda en external_records.
   */
  async processErpSync(payload: {
    connectionId: string;
    merchantId: string;
    provider: ErpProvider;
    resource: string;
    cursor: string | null;
  }) {
    const { connectionId, merchantId, provider, resource, cursor } = payload;
    this.logger.log(
      `Processing ERP sync ${provider}/${resource} for connection ${connectionId}`,
    );

    const connection = await this.prisma.erpConnection.findFirst({
      where: { id: connectionId, merchantId },
    });
    if (!connection) {
      throw new Error('CONNECTION_NOT_FOUND');
    }

    const adapter = ADAPTERS[provider];
    if (!adapter) {
      throw new Error('UNSUPPORTED_PROVIDER');
    }

    let result: {
      records: unknown[];
      nextCursor?: string;
      sourceUpdatedAt?: string;
    };
    try {
      if (resource === 'sales_orders') {
        result = await adapter.pullSalesOrders(
          connectionId,
          cursor ?? undefined,
        );
      } else if (resource === 'invoices') {
        result = await adapter.pullInvoices(connectionId, cursor ?? undefined);
      } else if (resource === 'shipments' && adapter.pullShipments) {
        result = await adapter.pullShipments(connectionId, cursor ?? undefined);
      } else if (resource === 'payments' && adapter.pullPayments) {
        result = await adapter.pullPayments!(connectionId, cursor ?? undefined);
      } else {
        result = { records: [], nextCursor: undefined };
      }
    } catch (error) {
      await this.prisma.erpConnection.update({
        where: { id: connectionId },
        data: { status: 'error', lastSyncError: String(error).slice(0, 1000) },
      });
      throw error;
    }

    // Guardar/actualizar registros normalizados.
    const recordTypeMap: Record<string, string> = {
      sales_orders: 'sales_order',
      invoices: 'invoice',
      shipments: 'shipment',
      payments: 'payment',
    };
    const recordType = recordTypeMap[resource] ?? resource;

    for (const raw of result.records) {
      const rawRecord = raw as Record<string, unknown>;
      const externalId = String(rawRecord?.externalId ?? rawRecord?.id ?? '');
      if (!externalId) continue;

      const normalizedPayload = {
        provider,
        resource,
        ...(rawRecord as Record<string, unknown>),
      };
      const sourceHash = contentHash(normalizedPayload);

      await this.prisma.externalRecord.upsert({
        where: {
          connectionId_recordType_externalId: {
            connectionId,
            recordType,
            externalId,
          },
        },
        create: {
          merchantId,
          connectionId,
          recordType,
          externalId,
          updatedAt: result.sourceUpdatedAt
            ? new Date(result.sourceUpdatedAt)
            : new Date(),
          normalizedPayload,
          sourceHash,
        },
        update: {
          updatedAt: result.sourceUpdatedAt
            ? new Date(result.sourceUpdatedAt)
            : new Date(),
          normalizedPayload,
          sourceHash,
        },
      });
    }

    // Actualizar cursor de sincronización.
    await this.prisma.erpSyncCursor.upsert({
      where: { connectionId_resource: { connectionId, resource } },
      create: {
        connectionId,
        resource,
        cursor: result.nextCursor ?? null,
        lastSuccessAt: new Date(),
        lastError: null,
      },
      update: {
        cursor: result.nextCursor ?? null,
        lastSuccessAt: new Date(),
        lastError: null,
      },
    });

    await this.prisma.erpConnection.update({
      where: { id: connectionId },
      data: {
        status: 'connected',
        lastSyncAt: new Date(),
        lastSyncError: null,
      },
    });

    await this.audit.append({
      merchantId: SYSTEM_MERCHANT_ID,
      actorUserId: null,
      actorKind: 'SYSTEM',
      resourceType: 'MERCHANT',
      resourceId: connectionId,
      outcome: 'SUCCEEDED',
      record: {
        action: 'INGESTION_FINISHED',
        details: {},
      },
    });

    return { processed: result.records.length, nextCursor: result.nextCursor };
  }
}
