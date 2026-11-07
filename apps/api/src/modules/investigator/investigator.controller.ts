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
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  InvestigationListSchema,
  InvestigationResponseSchema,
  StartInvestigationSchema,
  type StartInvestigation,
} from '@resolve-ai/contracts';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  type MerchantRequest,
} from '../merchants/index.js';
import { InvestigatorService } from './investigator.service.js';

@ApiTags('investigator')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
@Controller('transactions/:transactionId/investigations')
export class InvestigatorController {
  constructor(
    @Inject(InvestigatorService)
    private readonly investigator: InvestigatorService,
  ) {}

  @Post()
  @MerchantAdminOnly()
  @ApiOperation({
    summary:
      'Start a bounded read-only INR investigation (ADMIN, merchant opt-in required)',
  })
  @ApiBody({ schema: zodOpenApi(StartInvestigationSchema) })
  @ApiResponse({
    status: 201,
    schema: zodOpenApi(InvestigationResponseSchema),
    description:
      'Persisted run; inspect status/errorCode. FAILED is never a completed investigation.',
  })
  start(
    @Req() req: MerchantRequest,
    @Param('transactionId', new ZodValidationPipe(z.uuid()))
    transactionId: string,
    @Body(new ZodValidationPipe(StartInvestigationSchema))
    body: StartInvestigation,
  ) {
    return this.investigator.start(req.merchantActor, transactionId, body);
  }

  @Get()
  @ApiOperation({
    summary: 'Read the latest 20 investigations for the authorized transaction',
  })
  @ApiResponse({ status: 200, schema: zodOpenApi(InvestigationListSchema) })
  list(
    @Req() req: MerchantRequest,
    @Param('transactionId', new ZodValidationPipe(z.uuid()))
    transactionId: string,
  ) {
    return this.investigator.list(req.merchantActor.merchantId, transactionId);
  }

  @Get(':id')
  @ApiResponse({ status: 200, schema: zodOpenApi(InvestigationResponseSchema) })
  detail(
    @Req() req: MerchantRequest,
    @Param('transactionId', new ZodValidationPipe(z.uuid()))
    transactionId: string,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.investigator.detail(
      req.merchantActor.merchantId,
      transactionId,
      id,
    );
  }
}
