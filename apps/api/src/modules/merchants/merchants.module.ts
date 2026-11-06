import { Module } from '@nestjs/common';
import { SupabaseAuthService } from './auth/supabase-auth.service.js';
import { MerchantAccessGuard } from './auth/merchant-access.guard.js';
import { MerchantsController } from './merchants.controller.js';
import { MerchantsService } from './merchants.service.js';
import {
  PAYPAL_FETCH,
  PayPalConnectionClient,
} from './paypal/paypal-connection.client.js';

@Module({
  controllers: [MerchantsController],
  providers: [
    SupabaseAuthService,
    MerchantAccessGuard,
    MerchantsService,
    PayPalConnectionClient,
    { provide: PAYPAL_FETCH, useValue: globalThis.fetch },
  ],
  exports: [MerchantsService, MerchantAccessGuard, SupabaseAuthService],
})
export class MerchantsModule {}
