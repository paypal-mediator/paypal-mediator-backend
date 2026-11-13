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
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  StartInvestigationSchema,
  DisputeWorkflowResponseSchema,
  type DisputeWorkflowResponse,
  type StartInvestigation,
} from '@resolve-ai/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import { ApiException } from '../../common/http/api.exception.js';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  type MerchantRequest,
} from '../merchants/index.js';
import { DisputesService } from '../disputes/index.js';
import { InvestigatorService } from '../investigator/index.js';
import { VerifierService } from './verifier.service.js';

// Composition boundary: dependencies point towards M07, avoiding a module cycle.
@ApiTags('disputes')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
@Controller('disputes')
export class DisputeWorkflowController {
  constructor(
    @Inject(DisputesService) private readonly disputes: DisputesService,
    @Inject(InvestigatorService)
    private readonly investigator: InvestigatorService,
    @Inject(VerifierService) private readonly verifier: VerifierService,
  ) {}

  @Post(':id/investigate')
  @MerchantAdminOnly()
  @ApiOperation({
    summary:
      'Run one bounded investigation and independent INR dispute review; submission requires separate ADMIN approval',
  })
  @ApiBody({ schema: zodOpenApi(StartInvestigationSchema) })
  @ApiResponse({
    status: 201,
    schema: zodOpenApi(DisputeWorkflowResponseSchema),
  })
  async investigate(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(StartInvestigationSchema))
    body: StartInvestigation,
  ): Promise<DisputeWorkflowResponse> {
    const actor = request.merchantActor;
    const dispute = await this.disputes.detail(actor.merchantId, id);
    if (
      dispute.link.status !== 'LINKED' ||
      !dispute.link.transactionId ||
      dispute.reasonCategory !== 'ITEM_NOT_RECEIVED' ||
      dispute.paypalStatus === 'RESOLVED'
    )
      throw new ApiException(
        'DISPUTE_NOT_VERIFIABLE',
        'An open linked INR dispute is required',
        409,
      );
    const conversation = await this.disputes.conversationForTransaction(
      actor.merchantId,
      dispute.link.transactionId,
    );
    if (conversation?.paypalDisputeId !== dispute.paypalDisputeId)
      throw new ApiException(
        'DISPUTE_CONTEXT_CONFLICT',
        'The investigator context belongs to another dispute',
        409,
      );
    const investigation = await this.investigator.start(
      actor,
      dispute.link.transactionId,
      body,
    );
    if (investigation.status !== 'COMPLETED' || investigation.stale)
      return { investigation, verification: null, submissionAuthorized: false };
    const latest = await this.disputes.detail(actor.merchantId, id);
    if (
      latest.lastEventAt !== dispute.lastEventAt ||
      latest.link.transactionId !== dispute.link.transactionId
    )
      throw new ApiException(
        'DISPUTE_CONTEXT_CHANGED',
        'Dispute changed during investigation; request a new review',
        409,
      );
    const verification = await this.verifier.verify(
      actor,
      dispute.link.transactionId,
      investigation.id,
      { idempotencyKey: body.idempotencyKey, disputeId: id },
    );
    return { investigation, verification, submissionAuthorized: false };
  }
}
