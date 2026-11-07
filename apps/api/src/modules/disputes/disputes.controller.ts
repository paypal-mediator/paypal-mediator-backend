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
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  DisputeDetailSchema,
  DisputeListResponseSchema,
  DisputeQuerySchema,
  type DisputeQuery,
} from '@resolve-ai/contracts';
import {
  MerchantAccessGuard,
  type MerchantRequest,
} from '../merchants/index.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import { DisputesService } from './disputes.service.js';

@ApiTags('disputes')
@ApiBearerAuth('supabase')
@ApiResponse({ status: 401, description: 'Missing or invalid user token' })
@ApiResponse({ status: 403, description: 'No active merchant membership' })
@ApiResponse({ status: 400, description: 'Invalid identifier or pagination' })
@UseGuards(MerchantAccessGuard)
@Controller('disputes')
export class DisputesController {
  constructor(
    @Inject(DisputesService)
    private readonly disputes: DisputesService,
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
  @ApiQuery({
    name: 'internalState',
    required: false,
    schema: {
      type: 'string',
      enum: [
        'DETECTED',
        'LINKED',
        'NEEDS_REVIEW',
        'RESOLVED_WON',
        'RESOLVED_LOST',
        'CLOSED',
      ],
    },
  })
  @ApiQuery({
    name: 'paypalStatus',
    required: false,
    schema: {
      type: 'string',
      enum: [
        'OPEN',
        'WAITING_FOR_BUYER_RESPONSE',
        'WAITING_FOR_SELLER_RESPONSE',
        'UNDER_REVIEW',
        'RESOLVED',
        'OTHER',
      ],
    },
  })
  @ApiOperation({
    summary: 'List disputes with separate PayPal and internal states',
  })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(DisputeListResponseSchema),
  })
  list(
    @Req() request: MerchantRequest,
    @Query(new ZodValidationPipe(DisputeQuerySchema))
    query: DisputeQuery,
  ) {
    return this.disputes.list(request.merchantActor.merchantId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read a dispute with its ordered event timeline',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({
    status: 404,
    description: 'Dispute not found for this merchant',
  })
  @ApiResponse({ status: 200, schema: zodOpenApi(DisputeDetailSchema) })
  detail(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.disputes.detail(request.merchantActor.merchantId, id);
  }
}
