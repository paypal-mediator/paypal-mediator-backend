import {
  Body,
  Controller,
  Get,
  Inject,
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
  CreateSubscriptionSchema,
  PlanResponseSchema,
  SubscriptionResponseSchema,
  type CreateSubscription,
} from '@resolve-ai/contracts';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  type MerchantRequest,
} from '../merchants/auth/merchant-access.guard.js';
import { BillingService } from './billing.service.js';

@ApiTags('billing')
@ApiBearerAuth('supabase')
@ApiResponse({
  status: 401,
  description: 'Missing or invalid Supabase user token',
})
@ApiResponse({
  status: 403,
  description: 'No active membership or insufficient role',
})
@UseGuards(MerchantAccessGuard)
@Controller('billing')
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: 'List active subscription plans and prices' })
  @ApiResponse({ status: 200, schema: zodOpenApi(PlanResponseSchema) })
  getPlans() {
    return this.billing.getPlans();
  }

  @Get('subscription')
  @ApiOperation({
    summary: 'Read the active subscription of the merchant in context',
  })
  @ApiResponse({ status: 200, schema: zodOpenApi(SubscriptionResponseSchema) })
  @ApiResponse({ status: 404, description: 'No active subscription found' })
  getSubscription(@Req() request: MerchantRequest) {
    return this.billing.getSubscription(request.merchantActor.merchantId);
  }

  @Post('subscription')
  @MerchantAdminOnly()
  @ApiOperation({
    summary: 'Create a subscription for the merchant (admin only)',
  })
  @ApiBody({
    schema: { ...zodOpenApi(CreateSubscriptionSchema), minProperties: 1 },
  })
  @ApiResponse({ status: 201, schema: zodOpenApi(SubscriptionResponseSchema) })
  createSubscription(
    @Req() request: MerchantRequest,
    @Body(new ZodValidationPipe(CreateSubscriptionSchema))
    body: CreateSubscription,
  ) {
    return this.billing.createSubscription(
      request.merchantActor.merchantId,
      body.planId,
      request.merchantActor.userId,
    );
  }
}
