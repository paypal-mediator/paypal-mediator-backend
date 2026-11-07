import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { SupabaseAuthService } from './auth/supabase-auth.service.js';
import { MerchantAccessGuard } from './auth/merchant-access.guard.js';
import { MerchantsController } from './merchants.controller.js';
import { MerchantsService } from './merchants.service.js';
import {
  PAYPAL_FETCH,
  PayPalConnectionClient,
} from './paypal/paypal-connection.client.js';
import { PayPalAuthService } from './paypal/paypal-auth.service.js';

@Module({
  imports: [AuditModule],
  controllers: [MerchantsController],
  providers: [
    SupabaseAuthService,
    MerchantAccessGuard,
    MerchantsService,
    PayPalConnectionClient,
    PayPalAuthService,
    { provide: PAYPAL_FETCH, useFactory: () => globalThis.fetch },
  ],
  exports: [
    MerchantsService,
    MerchantAccessGuard,
    SupabaseAuthService,
    PayPalAuthService,
    PAYPAL_FETCH,
  ],
})
export class MerchantsModule {}
