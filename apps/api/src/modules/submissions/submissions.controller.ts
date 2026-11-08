import {
  Body,
  Controller,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  SubmissionResultSchema,
  SubmitRequestSchema,
  type SubmissionResult,
  type SubmitRequest,
} from '@resolve-ai/contracts';
import {
  MerchantAccessGuard,
  type MerchantRequest,
} from '../merchants/index.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import { SubmissionsService } from './submissions.service.js';

@ApiTags('submissions')
@ApiBearerAuth('supabase')
@ApiResponse({ status: 401, description: 'Missing or invalid user token' })
@ApiResponse({ status: 403, description: 'No active merchant membership' })
@UseGuards(MerchantAccessGuard)
@Controller('disputes')
export class SubmissionsController {
  constructor(
    @Inject(SubmissionsService)
    private readonly submissions: SubmissionsService,
  ) {}

  @Post(':id/submit')
  @ApiOperation({
    summary:
      'Submit evidence to PayPal after Submission Guard approval (M08). Requires Verifier APPROVED and merchant authorization.',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(SubmissionResultSchema),
    description: 'Submission recorded (SUBMITTED, BLOCKED, or FAILED)',
  })
  @ApiResponse({
    status: 404,
    description: 'Dispute not found for this merchant',
  })
  @ApiResponse({
    status: 409,
    description: 'Idempotency key already used for a different dispute',
  })
  submit(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) disputeId: string,
    @Body(new ZodValidationPipe(SubmitRequestSchema))
    body: SubmitRequest,
  ): Promise<SubmissionResult> {
    return this.submissions.submit(
      request.merchantActor.merchantId,
      disputeId,
      request.merchantActor.userId,
      body,
    );
  }
}
