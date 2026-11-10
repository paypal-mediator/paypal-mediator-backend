import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  ErpCatalogResponseSchema,
  ErpConnectionListResponseSchema,
  ErpConnectionStatusResponseSchema,
  ErpSyncTriggerSchema,
  ExternalRecordListResponseSchema,
  StartErpConnectionSchema,
  ConnectErpWithKeySchema,
  TransactionLinkListResponseSchema,
  type ErpCatalogResponse,
  type ErpConnectionListResponse,
  type ErpConnectionStatusResponse,
  type ExternalRecordListResponse,
  type TransactionLinkListResponse,
} from '@resolve-ai/contracts';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import {
  MerchantAccessGuard,
  type MerchantRequest,
} from '../merchants/index.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { IntegrationsService } from './integrations.service.js';

@ApiTags('integrations')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(
    @Inject(IntegrationsService)
    private readonly integrations: IntegrationsService,
  ) {}

  @Get('catalog')
  @ApiOperation({
    summary: 'Catálogo de proveedores ERP disponibles para integración',
  })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(ErpCatalogResponseSchema),
  })
  catalog(): ErpCatalogResponse {
    return this.integrations.getCatalog() as any;
  }

  @Get()
  @ApiOperation({
    summary: 'Lista las conexiones ERP del merchant autenticado',
  })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(ErpConnectionListResponseSchema),
  })
  async list(@Req() req: MerchantRequest): Promise<ErpConnectionListResponse> {
    return this.integrations
      .listConnections(req.merchantActor.merchantId) as any;
  }

  @Post(':provider/start')
  @ApiOperation({
    summary: 'Inicia el flujo de conexión de un proveedor ERP (OAuth u otro)',
  })
  @ApiResponse({
    status: 200,
    description: 'Devuelve URL de autorización o instrucciones de conexión',
  })
  async start(
    @Req() req: MerchantRequest,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(StartErpConnectionSchema)) body: {
      provider: string;
    },
  ) {
    if (body.provider !== provider) {
      throw new Error('PROVIDER_MISMATCH');
    }
    // Para proveedores API Key (Bind, Siigo, etc.), el flujo se completa con connect-with-key.
    // Para OAuth, aquí se generaría la URL de autorización.
    return {
      provider,
      nextStep: 'connect-with-key',
      message: 'Usa POST /api/integrations/:provider/connect-with-key para API Key, o completa el flujo OAuth si aplica.',
    };
  }

  @Post(':provider/connect-with-key')
  @ApiOperation({
    summary: 'Conecta un ERP usando API Key (Bind, Siigo México, Odoo, etc.)',
  })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(ErpConnectionStatusResponseSchema),
  })
  async connectWithKey(
    @Req() req: MerchantRequest,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(ConnectErpWithKeySchema)) body: {
      provider: string;
      apiKey: string;
      baseUrl?: string;
    },
  ) {
    if (body.provider !== provider) {
      throw new Error('PROVIDER_MISMATCH');
    }
    const result = await this.integrations.connectWithKey(
      req.merchantActor.merchantId,
      body.provider as any,
      body.apiKey,
      body.baseUrl ?? undefined,
    );
    const status = await this.integrations.getConnectionStatus(
      req.merchantActor.merchantId,
      result.id,
    );
    return status as ErpConnectionStatusResponse;
  }

  @Get(':connectionId/status')
  @ApiOperation({
    summary: 'Obtiene el estado y capacidades de una conexión ERP',
  })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(ErpConnectionStatusResponseSchema),
  })
  async status(
    @Req() req: MerchantRequest,
    @Param('connectionId') connectionId: string,
  ): Promise<ErpConnectionStatusResponse> {
    return this.integrations
      .getConnectionStatus(req.merchantActor.merchantId, connectionId) as any;
  }

  @Post(':connectionId/sync')
  @ApiOperation({
    summary: 'Dispara una sincronización incremental de un ERP conectado',
  })
  @ApiResponse({
    status: 200,
    description: 'Sincronización encolada para procesamiento asíncrono',
  })
  async sync(
    @Req() req: MerchantRequest,
    @Param('connectionId') connectionId: string,
    @Body(new ZodValidationPipe(ErpSyncTriggerSchema)) body: {
      connectionId: string;
      resource?: string;
    },
  ) {
    if (body.connectionId !== connectionId) {
      throw new Error('CONNECTION_ID_MISMATCH');
    }
    return this.integrations.sync(
      req.merchantActor.merchantId,
      connectionId,
      body.resource as any,
    );
  }

  @Post(':connectionId/disconnect')
  @ApiOperation({
    summary: 'Desconecta un ERP y revoca su acceso',
  })
  @ApiResponse({ status: 200, description: 'Conexión desconectada' })
  async disconnect(
    @Req() req: MerchantRequest,
    @Param('connectionId') connectionId: string,
  ) {
    return this.integrations.disconnect(
      req.merchantActor.merchantId,
      connectionId,
    );
  }

  @Get('transactions/:captureId/linked-records')
  @ApiOperation({
    summary: 'Lista registros de ERP vinculados a una captura de PayPal',
  })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(TransactionLinkListResponseSchema),
  })
  async linkedRecords(
    @Req() req: MerchantRequest,
    @Param('captureId') captureId: string,
  ): Promise<TransactionLinkListResponse> {
    return this.integrations
      .getLinkedRecords(req.merchantActor.merchantId, captureId) as any;
  }

  @Get('disputes/:disputeId/evidence-sources')
  @ApiOperation({
    summary: 'Lista fuentes de evidencia de ERP para una disputa',
  })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(ExternalRecordListResponseSchema),
  })
  async evidenceSources(): Promise<ExternalRecordListResponse> {
    // Por ahora devolvemos una lista vacía.
    // En una implementación completa, se filtraría por disputa vinculada.
    return {
      items: [],
      total: 0,
    };
  }
}
