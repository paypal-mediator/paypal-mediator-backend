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
  VerificationListSchema,
  VerificationResponseSchema,
  StartVerificationSchema,
  type StartVerification,
} from '@resolve-ai/contracts';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  type MerchantRequest,
} from '../merchants/index.js';
import { VerifierService } from './verifier.service.js';

@ApiTags('verifier')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
@Controller(
  'transactions/:transactionId/investigations/:investigationId/verifications',
)
export class VerifierController {
  constructor(
    @Inject(VerifierService)
    private readonly verifier: VerifierService,
  ) {}

  @Post()
  @MerchantAdminOnly()
  @ApiOperation({
    summary:
      'Independently verify a completed INR investigation (ADMIN, merchant opt-in required)',
  })
  @ApiBody({ schema: zodOpenApi(StartVerificationSchema) })
  @ApiResponse({
    status: 201,
    schema: zodOpenApi(VerificationResponseSchema),
    description:
      'Persisted run; inspect status/errorCode. FAILED is never a completed investigation.',
  })
  start(
    @Req() req: MerchantRequest,
    @Param('investigationId', new ZodValidationPipe(z.uuid()))
    investigationId: string,
    @Param('transactionId', new ZodValidationPipe(z.uuid()))
    transactionId: string,
    @Body(new ZodValidationPipe(StartVerificationSchema))
    body: StartVerification,
  ) {
    return this.verifier.verify(
      req.merchantActor,
      transactionId,
      investigationId,
      body,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Read the latest 20 verifications for the authorized transaction',
  })
  @ApiResponse({ status: 200, schema: zodOpenApi(VerificationListSchema) })
  list(
    @Req() req: MerchantRequest,
    @Param('investigationId', new ZodValidationPipe(z.uuid()))
    investigationId: string,
    @Param('transactionId', new ZodValidationPipe(z.uuid()))
    transactionId: string,
  ) {
    return this.verifier.list(
      req.merchantActor.merchantId,
      transactionId,
      investigationId,
    );
  }

  @Get(':id')
  @ApiResponse({ status: 200, schema: zodOpenApi(VerificationResponseSchema) })
  detail(
    @Req() req: MerchantRequest,
    @Param('investigationId', new ZodValidationPipe(z.uuid()))
    investigationId: string,
    @Param('transactionId', new ZodValidationPipe(z.uuid()))
    transactionId: string,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.verifier.detail(
      req.merchantActor.merchantId,
      transactionId,
      investigationId,
      id,
    );
  }
}
