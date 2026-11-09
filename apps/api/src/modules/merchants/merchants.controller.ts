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

  @Get('merchants')
  @ApiOperation({
    summary: 'List all merchants the authenticated user belongs to',
  })
  @ApiResponse({ status: 200, schema: zodOpenApi(MerchantListResponseSchema) })
  listMerchants(@Req() request: MerchantRequest) {
    return this.merchants.listMerchants(request.merchantActor.userId);
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
