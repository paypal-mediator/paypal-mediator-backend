import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  UseGuards,
  Body,
  Post,
  StreamableFile,
  Header,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiQuery,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  TransactionQuerySchema,
  TransactionResponseSchema,
  TransactionListResponseSchema,
  type TransactionQuery,
  RegisterEvidenceSchema,
  EvidenceDossierResponseSchema,
  EvidenceRegistrationResponseSchema,
  type RegisterEvidence,
  UploadEvidenceFileSchema,
  EvidenceReceiptSchema,
  type UploadEvidenceFile,
} from '@resolve-ai/contracts';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  type MerchantRequest,
} from '../merchants/index.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import { TransactionsService } from './transactions.service.js';

@ApiTags('transactions')
@ApiBearerAuth('supabase')
@ApiResponse({ status: 401, description: 'Missing or invalid user token' })
@ApiResponse({ status: 403, description: 'No active merchant membership' })
@ApiResponse({ status: 400, description: 'Invalid identifier or pagination' })
@UseGuards(MerchantAccessGuard)
@Controller('transactions')
export class TransactionsController {
  @Post(':id/refresh-order-sources')
  @MerchantAdminOnly()
  @ApiOperation({
    summary:
      'Fetch/retry registered order information sources (ADMIN); source failures remain explicit',
  })
  @ApiResponse({ status: 201, schema: zodOpenApi(TransactionResponseSchema) })
  refreshOrderSources(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.transactions.refreshOrderSources(request.merchantActor, id);
  }
  constructor(
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
  ) {}

  @Post(':id/evidence/files')
  @MerchantAdminOnly()
  @ApiOperation({
    summary:
      'Store an original document in private Storage (ADMIN, maximum 512 KiB)',
  })
  @ApiBody({ schema: zodOpenApi(UploadEvidenceFileSchema) })
  @ApiResponse({ status: 201, schema: zodOpenApi(EvidenceReceiptSchema) })
  @ApiResponse({
    status: 409,
    description: 'Source, version or file integrity conflict',
  })
  @ApiResponse({
    status: 503,
    description: 'Storage is unconfigured or bucket is public',
  })
  @ApiResponse({ status: 502, description: 'Storage operation failed' })
  uploadFile(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(UploadEvidenceFileSchema))
    body: UploadEvidenceFile,
  ) {
    return this.transactions.uploadEvidenceFile(
      request.merchantActor,
      id,
      body,
    );
  }

  @Get(':id/evidence/files/:evidenceId')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Download an authorized original after checking its SHA-256',
  })
  @ApiResponse({
    status: 200,
    description: 'Original PDF, PNG or JPEG as an attachment',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Transaction or file not found for this merchant',
  })
  @ApiResponse({
    status: 409,
    description: 'Metadata or original file integrity check failed',
  })
  @ApiResponse({
    status: 503,
    description: 'Storage is unconfigured or bucket is public',
  })
  @ApiResponse({ status: 502, description: 'Storage operation failed' })
  async downloadFile(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Param('evidenceId', new ZodValidationPipe(z.uuid())) evidenceId: string,
  ) {
    const file = await this.transactions.downloadEvidenceFile(
      request.merchantActor.merchantId,
      id,
      evidenceId,
      request.merchantActor.userId,
    );
    return new StreamableFile(file.bytes, {
      type: file.mediaType,
      length: file.byteLength,
      disposition: `attachment; filename="${file.fileName}"`,
    });
  }

  @Get()
  @ApiQuery({
    name: 'page',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: 'paypalCaptureId', required: false, type: String })
  @ApiOperation({
    summary: 'List captured payments for the authorized merchant',
  })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(TransactionListResponseSchema),
  })
  list(
    @Req() request: MerchantRequest,
    @Query(new ZodValidationPipe(TransactionQuerySchema))
    query: TransactionQuery,
  ) {
    return this.transactions.list(request.merchantActor.merchantId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read a captured payment and its documentary checklist',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({
    status: 404,
    description: 'Transaction not found for this merchant',
  })
  @ApiResponse({ status: 200, schema: zodOpenApi(TransactionResponseSchema) })
  detail(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.transactions.detail(request.merchantActor.merchantId, id);
  }

  @Post(':id/refresh-evidence')
  @MerchantAdminOnly()
  @ApiOperation({
    summary:
      'Reconcile order and persist payment/order evidence in the dossier (ADMIN)',
  })
  @ApiResponse({ status: 201, schema: zodOpenApi(TransactionResponseSchema) })
  refresh(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.transactions.refreshEvidence(request.merchantActor, id);
  }

  @Get(':id/evidence')
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(EvidenceDossierResponseSchema),
  })
  dossier(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.transactions.dossier(request.merchantActor.merchantId, id);
  }

  @Post(':id/evidence')
  @MerchantAdminOnly()
  @ApiOperation({
    summary:
      'Append a sourced tracking/delivery record; this does not verify delivery authenticity (ADMIN)',
  })
  @ApiBody({ schema: zodOpenApi(RegisterEvidenceSchema) })
  @ApiResponse({
    status: 201,
    schema: zodOpenApi(EvidenceRegistrationResponseSchema),
  })
  evidence(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(RegisterEvidenceSchema)) body: RegisterEvidence,
  ) {
    return this.transactions.registerEvidence(request.merchantActor, id, body);
  }
}
