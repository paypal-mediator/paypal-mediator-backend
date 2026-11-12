import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  MediationPolicySchema,
  MediationActionSchema,
  MediationMessageInputSchema,
  MediationStartSchema,
  MediationEvidenceInputSchema,
  type MediationPolicy,
  type MediationAction,
} from '@resolve-ai/contracts';
import {
  MerchantAccessGuard,
  type MerchantRequest,
} from '../merchants/index.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { MediationService } from './mediation.service.js';

@ApiTags('mediation')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
@Controller()
export class MediationController {
  constructor(
    @Inject(MediationService) private readonly mediation: MediationService,
  ) {}
  @Get('settings/mediation')
  policy(@Req() req: MerchantRequest) {
    return this.mediation.policy(req.merchantActor.merchantId);
  }
  @Put('settings/mediation')
  configure(
    @Req() req: MerchantRequest,
    @Body(new ZodValidationPipe(MediationPolicySchema)) input: MediationPolicy,
  ) {
    return this.mediation.configure(req.merchantActor, input);
  }
  @Get('disputes/:id/mediation')
  view(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.mediation.view(req.merchantActor.merchantId, id);
  }
  @Post('disputes/:id/mediation')
  start(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(MediationStartSchema))
    input: z.infer<typeof MediationStartSchema>,
  ) {
    return this.mediation.start(req.merchantActor, id, input);
  }
  @Post('disputes/:id/mediation/refresh')
  refresh(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.mediation.refresh(req.merchantActor, id);
  }
  @Post('disputes/:id/mediation/messages')
  message(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(MediationMessageInputSchema))
    input: z.infer<typeof MediationMessageInputSchema>,
  ) {
    return this.mediation.message(req.merchantActor, id, input);
  }
  @Post('disputes/:id/mediation/evidence/files')
  evidence(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(MediationEvidenceInputSchema))
    input: z.infer<typeof MediationEvidenceInputSchema>,
  ) {
    return this.mediation.evidence(req.merchantActor, id, input);
  }
  @Post('disputes/:id/mediation/actions')
  action(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(MediationActionSchema)) input: MediationAction,
  ) {
    return this.mediation.action(req.merchantActor, id, input);
  }
}
