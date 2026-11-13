import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  IngestionJobsQuerySchema,
  IngestionJobsResponseSchema,
  IngestionHealthSchema,
  RetryIngestionSchema,
  RetryIngestionResponseSchema,
  type IngestionJobsQuery,
} from '@resolve-ai/contracts';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  type MerchantRequest,
} from '../merchants/index.js';
import { IngestionOperationsService } from './ingestion-operations.service.js';

@Controller('event-ingestion')
@ApiTags('event-ingestion')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
export class IngestionOperationsController {
  constructor(
    @Inject(IngestionOperationsService)
    private readonly operations: IngestionOperationsService,
  ) {}

  @Get('health')
  @ApiResponse({ status: 200, schema: zodOpenApi(IngestionHealthSchema) })
  health(@Req() req: MerchantRequest) {
    return this.operations.health(req.merchantActor.merchantId);
  }

  @Get('jobs')
  @ApiResponse({ status: 200, schema: zodOpenApi(IngestionJobsResponseSchema) })
  list(
    @Req() req: MerchantRequest,
    @Query(new ZodValidationPipe(IngestionJobsQuerySchema))
    query: IngestionJobsQuery,
  ) {
    return this.operations.list(req.merchantActor.merchantId, query);
  }

  @Post('jobs/:id/retry')
  @HttpCode(200)
  @MerchantAdminOnly()
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(RetryIngestionResponseSchema),
  })
  retry(
    @Req() req: MerchantRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RetryIngestionSchema))
    input: Record<string, never>,
  ) {
    void input;
    return this.operations.retry(req.merchantActor, id);
  }
}
