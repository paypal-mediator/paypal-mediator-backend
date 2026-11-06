import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  TransactionQuerySchema,
  TransactionResponseSchema,
  TransactionListResponseSchema,
  type TransactionQuery,
} from '@resolve-ai/contracts';
import {
  MerchantAccessGuard,
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
  constructor(
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
  ) {}

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
}
