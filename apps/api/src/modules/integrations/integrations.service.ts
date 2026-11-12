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
import { SiigoAdapter } from './adapters/siigo.adapter.js';
import { OdooAdapter } from './adapters/odoo.adapter.js';
import { ErpNextAdapter } from './adapters/erpnext.adapter.js';
import type { ErpConnector } from './interfaces/erp-connector.interface.js';
import { contentHash } from '../../common/data/content-hash.js';
import { ApiException } from '../../common/http/api.exception.js';
import {
  encryptErpSecret,
  decryptErpSecret,
  type ErpSecretPayload,
} from '../../common/crypto/secret-box.js';

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
    provider: 'odoo',
    name: 'Odoo',
    segment: 'Pequeña / mediana',
    integrationType: 'api_key',
    connectionExperience: 'URL de instancia + API Key',
    capabilities: ['customers', 'sales_orders', 'invoices', 'shipments'],
    priority: 'P0',
  },
];

const ADAPTERS: Record<string, ErpConnector> = {
  bind: new BindAdapter(),
  'siigo-mx': new SiigoAdapter(),
  odoo: new OdooAdapter(),
  erpnext: new ErpNextAdapter(),
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
    await this.jobs.registerHandler('ERP_SYNC', async (data) => {
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
    await this.jobs.connect();
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
    const credentials = await this.getDecryptedSecret(connectionId);
    const capabilities = adapter
      ? (await adapter.verifyConnection(credentials)).capabilities
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
    database?: string,
  ) {
    if (provider !== 'odoo') {
      throw new ApiException(
        'ERP_PROVIDER_UNAVAILABLE',
        'Only Odoo is available for new ERP connections',
        400,
      );
    }
    const adapter = ADAPTERS.odoo!;
    if (!database?.trim() || !baseUrl) {
      throw new ApiException(
        'ODOO_CONFIGURATION_REQUIRED',
        'Odoo URL and database are required',
        400,
      );
    }
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'https:' ||
      !/^[a-z0-9][a-z0-9-]*\.odoo\.com$/.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname)
    ) {
      throw new ApiException(
        'ODOO_URL_INVALID',
        'Use your HTTPS Odoo Online instance URL',
        400,
      );
    }
    baseUrl = url.origin;
    const secretPayload: ErpSecretPayload = {
      apiKey,
      baseUrl,
      database: database.trim(),
    };
    let verified;
    try {
      verified = await adapter.verifyConnection(secretPayload);
    } catch {
      throw new ApiException(
        'ERP_CONNECTION_VERIFICATION_FAILED',
        'Could not verify Odoo. Check the API key, database, permissions and API availability.',
        422,
      );
    }

    const encryptedPayload = await encryptErpSecret(
      secretPayload,
      this.environment,
    );

    const connection = await this.prisma.erpConnection.create({
      data: {
        merchantId,
        provider,
        externalTenantId: verified.externalTenantId,
        baseUrl,
        status: 'connected',
        scopes: null,
        lastSyncAt: null,
        lastSyncError: null,
        secret: {
          create: {
            encryptedPayload,
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
        action: 'SETTINGS_UPDATED',
        details: {
          displayNameChanged: false,
          allowInvestigations: false,
          allowSubmissions: false,
          requireMerchantApproval: true,
          erpProvider: provider,
        },
      },
    });

    return {
      id: connection.id,
      merchantId: connection.merchantId,
      provider: connection.provider,
      status: connection.status,
    };
  }

  /**
   * Obtiene credenciales desencriptadas para un adapter.
   * Lanza si no existe MASTER_ENCRYPTION_KEY o la conexión no existe.
   */
  private async getDecryptedSecret(
    connectionId: string,
  ): Promise<ErpSecretPayload> {
    const secret = await this.prisma.erpSecret.findUnique({
      where: { connectionId },
    });
    if (!secret) {
      throw new Error('ERP_SECRET_NOT_FOUND');
    }
    return decryptErpSecret(secret.encryptedPayload, this.environment);
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
        const credentials = await this.getDecryptedSecret(connectionId);
        await adapter.disconnect(credentials);
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

    if (!['connected', 'error', 'rate_limited'].includes(connection.status)) {
      throw new ApiException(
        'ERP_CONNECTION_NOT_READY',
        'Connection is not ready for synchronization',
        409,
      );
    }

    const adapter = ADAPTERS[connection.provider];
    if (!adapter) {
      throw new Error('UNSUPPORTED_PROVIDER');
    }

    const supportedResources = [
      'sales_orders',
      'invoices',
      ...(adapter.pullShipments ? ['shipments'] : []),
      ...(adapter.pullPayments ? ['payments'] : []),
    ];
    if (resource && !supportedResources.includes(resource)) {
      throw new ApiException(
        'UNSUPPORTED_RESOURCE',
        'Unsupported ERP resource',
        400,
      );
    }
    const resources = resource ? [resource] : supportedResources;
    if (!this.jobs.isConnected()) {
      throw new ApiException(
        'ERP_QUEUE_UNAVAILABLE',
        'ERP synchronization queue is unavailable',
        503,
      );
    }

    await this.prisma.erpConnection.update({
      where: { id: connectionId },
      data: { status: 'syncing', lastSyncError: null },
    });
    try {
      for (const res of resources) {
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
    } catch {
      await this.prisma.erpConnection.update({
        where: { id: connectionId },
        data: { status: 'error', lastSyncError: 'ERP_ENQUEUE_FAILED' },
      });
      throw new ApiException(
        'ERP_ENQUEUE_FAILED',
        'ERP synchronization could not be fully queued',
        503,
      );
    }

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

  // Public shipment interface. Match exact payment/order/invoice references only.
  // It never infers ownership from an email, amount, or an unreviewed suggestion.
  async shipmentRecords(context: {
    merchantId: string;
    paypalCaptureId: string;
    paypalOrderId: string | null;
    merchantOrderReference: string | null;
    invoiceId: string | null;
    orderExternalId: string | null;
  }) {
    const { merchantId, paypalCaptureId } = context;
    const links = await this.prisma.transactionLink.findMany({
      where: {
        merchantId,
        paypalCaptureId,
        OR: [
          {
            matchMethod: { in: ['invoice_id_exact', 'custom_id_exact'] },
            confidence: 'high',
          },
          { reviewedBy: { not: null } },
        ],
      },
      include: { record: { include: { connection: true } } },
    });
    const references = [
      context.paypalOrderId,
      context.merchantOrderReference,
      context.invoiceId,
      context.orderExternalId,
    ].filter((x): x is string => Boolean(x));
    const matches = (raw: Record<string, unknown>) =>
      raw.paypalCaptureId === paypalCaptureId ||
      [
        'paypalOrderId',
        'merchantOrderReference',
        'orderExternalId',
        'invoiceId',
        'invoiceNumber',
        'orderId',
      ].some(
        (k) =>
          typeof raw[k] === 'string' && references.includes(raw[k] as string),
      );
    const rows = await this.prisma.externalRecord.findMany({
      where: {
        merchantId,
        recordType: 'shipment',
        OR: [
          {
            normalizedPayload: {
              path: ['paypalCaptureId'],
              equals: paypalCaptureId,
            },
          },
          ...[
            'paypalOrderId',
            'merchantOrderReference',
            'orderExternalId',
            'invoiceId',
            'invoiceNumber',
            'orderId',
          ].flatMap((field) =>
            references.map((reference) => ({
              normalizedPayload: { path: [field], equals: reference },
            })),
          ),
        ],
      },
      include: { connection: true },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });
    const records: Array<{
      original: Record<string, unknown>;
      provider: string;
      containsDemo: boolean;
    }> = [];
    const append = (raw: unknown, provider: string) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const original = raw as Record<string, unknown>;
      const shipments = Array.isArray(original.shipments)
        ? original.shipments
        : original.shipment &&
            typeof original.shipment === 'object' &&
            !Array.isArray(original.shipment)
          ? [original.shipment]
          : [original];
      for (const item of shipments)
        if (item && typeof item === 'object' && !Array.isArray(item))
          records.push({
            original: item as Record<string, unknown>,
            provider,
            containsDemo:
              provider === 'mock-erp' ||
              original.explicitMock === true ||
              original.containsDemo === true ||
              original.demo === true,
          });
    };
    for (const link of links)
      if (
        link.record.connection.merchantId === merchantId &&
        link.record.sourceHash === contentHash(link.record.normalizedPayload)
      )
        append(link.record.normalizedPayload, link.record.connection.provider);
    for (const row of rows)
      if (
        row.connection.merchantId === merchantId &&
        row.sourceHash === contentHash(row.normalizedPayload) &&
        matches(row.normalizedPayload as Record<string, unknown>)
      )
        append(row.normalizedPayload, row.connection.provider);
    const errors: string[] = [];
    const connections = await this.prisma.erpConnection.findMany({
      where: { merchantId, status: 'connected' },
    });
    for (const connection of connections) {
      const adapter = ADAPTERS[connection.provider];
      if (!adapter?.pullShipments) continue;
      let cursor: string | undefined;
      try {
        const credentials = await this.getDecryptedSecret(connection.id);
        // Bounded incremental reads; existing ERP jobs remain responsible for full sync.
        for (let page = 0; page < 3; page++) {
          const response = await adapter.pullShipments(credentials, cursor);
          for (const raw of response.records)
            if (
              raw &&
              typeof raw === 'object' &&
              !Array.isArray(raw) &&
              matches(raw as Record<string, unknown>)
            )
              append(raw, connection.provider);
          if (!response.nextCursor || response.nextCursor === cursor) break;
          cursor = response.nextCursor;
        }
      } catch {
        errors.push('ERP_SHIPMENTS_UNAVAILABLE');
      }
    }
    return {
      records,
      errors,
      connected: connections.length > 0 || links.length > 0,
    };
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

    // Obtener credenciales desencriptadas
    const credentials = await this.getDecryptedSecret(connectionId);

    let result: {
      records: unknown[];
      nextCursor?: string;
      sourceUpdatedAt?: string;
    };
    try {
      if (resource === 'sales_orders') {
        result = await adapter.pullSalesOrders(
          credentials,
          cursor ?? undefined,
        );
      } else if (resource === 'invoices') {
        result = await adapter.pullInvoices(credentials, cursor ?? undefined);
      } else if (resource === 'shipments' && adapter.pullShipments) {
        result = await adapter.pullShipments(credentials, cursor ?? undefined);
      } else if (resource === 'payments' && adapter.pullPayments) {
        result = await adapter.pullPayments!(credentials, cursor ?? undefined);
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
      merchantId,
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
