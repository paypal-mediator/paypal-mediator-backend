import {
  Body,
  Controller,
  Get,
  Inject,
  Patch,
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
  UpdateMerchantSettingsSchema,
  MerchantResponseSchema,
  IntegrationsResponseSchema,
  MerchantListResponseSchema,
  CreateMerchantSchema,
  type CreateMerchant,
  type UpdateMerchantSettings,
} from '@resolve-ai/contracts';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  type MerchantRequest,
} from './auth/merchant-access.guard.js';
import { MerchantsService } from './merchants.service.js';
import { SupabaseAuthService } from './auth/supabase-auth.service.js';
import type { Request } from 'express';

@ApiTags('merchants')
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
@Controller()
export class MerchantsController {
  constructor(
    @Inject(MerchantsService) private readonly merchants: MerchantsService,
  ) {}

  @Get('merchants/me')
  @ApiOperation({ summary: 'Read the authorized merchant, role and policy' })
  @ApiResponse({ status: 200, schema: zodOpenApi(MerchantResponseSchema) })
  getMerchant(@Req() request: MerchantRequest) {
    return this.merchants.getMerchant(request.merchantActor);
  }

  @Patch('merchants/me/settings')
  @MerchantAdminOnly()
  @ApiOperation({
    summary: 'Update merchant settings (admin only, approval always required)',
  })
  @ApiBody({
    schema: { ...zodOpenApi(UpdateMerchantSettingsSchema), minProperties: 1 },
  })
  @ApiResponse({ status: 200, schema: zodOpenApi(MerchantResponseSchema) })
  updateSettings(
    @Req() request: MerchantRequest,
    @Body(new ZodValidationPipe(UpdateMerchantSettingsSchema))
    settings: UpdateMerchantSettings,
  ) {
    return this.merchants.updateSettings(request.merchantActor, settings);
  }

  @Get('settings/integrations')
  @ApiOperation({
    summary:
      'Read persisted integration status without making PayPal calls or exposing secrets',
  })
  @ApiResponse({ status: 200, schema: zodOpenApi(IntegrationsResponseSchema) })
  integrations(@Req() request: MerchantRequest) {
    return this.merchants.getIntegrations(request.merchantActor.merchantId);
  }

  @Post('settings/integrations/paypal/check')
  @MerchantAdminOnly()
  @ApiOperation({
    summary:
      'Check Sandbox OAuth and disputes read access, and persist the outcome (admin only)',
  })
  @ApiResponse({
    status: 201,
    schema: zodOpenApi(IntegrationsResponseSchema),
    description:
      'Check completed; inspect connectionStatus and disputesReadStatus. Does not imply permission to send evidence.',
  })
  check(@Req() request: MerchantRequest) {
    return this.merchants.checkPayPal(request.merchantActor);
  }
}

@ApiTags('merchants')
@ApiBearerAuth('supabase')
@Controller()
export class MerchantAccountsController {
  constructor(
    @Inject(SupabaseAuthService) private readonly auth: SupabaseAuthService,
    @Inject(MerchantsService) private readonly merchants: MerchantsService,
  ) {}

  @Get('merchants')
  @ApiOperation({
    summary: 'List the signed-in account’s teams, including an empty list',
  })
  @ApiResponse({ status: 200, schema: zodOpenApi(MerchantListResponseSchema) })
  @ApiResponse({ status: 401, description: 'Missing or invalid user token' })
  async listMerchants(@Req() request: Request) {
    const userId = await this.auth.authenticate(request.headers.authorization);
    return this.merchants.listMerchants(userId);
  }

  @Post('merchants')
  @ApiOperation({ summary: 'Create a team and its initial ADMIN membership' })
  @ApiBody({ schema: zodOpenApi(CreateMerchantSchema) })
  @ApiResponse({ status: 201, schema: zodOpenApi(MerchantResponseSchema) })
  async createMerchant(
    @Req() request: Request,
    @Body(new ZodValidationPipe(CreateMerchantSchema)) input: CreateMerchant,
  ) {
    const userId = await this.auth.authenticate(request.headers.authorization);
    return this.merchants.createMerchant(userId, input);
  }
}
