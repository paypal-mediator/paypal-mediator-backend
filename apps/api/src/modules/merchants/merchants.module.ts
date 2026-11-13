import { Module } from '@nestjs/common';
import {
  TeamInvitationsController,
  AccountInvitationsController,
} from './merchant-invitations.controller.js';
import { MerchantInvitationsService } from './merchant-invitations.service.js';
import { InvitationMailer } from './invitation-mailer.js';
import { AuditModule } from '../monitoring/audit.module.js';
import { SupabaseAuthService } from './auth/supabase-auth.service.js';
import { MerchantAccessGuard } from './auth/merchant-access.guard.js';
import {
  MerchantAccountsController,
  MerchantsController,
} from './merchants.controller.js';
import { MerchantsService } from './merchants.service.js';
import {
  PAYPAL_FETCH,
  PayPalConnectionClient,
} from './paypal/paypal-connection.client.js';
import { PayPalAuthService } from './paypal/paypal-auth.service.js';
import { PayPalOnboardingService } from './paypal/paypal-onboarding.service.js';

@Module({
  imports: [AuditModule],
  controllers: [
    MerchantsController,
    MerchantAccountsController,
    TeamInvitationsController,
    AccountInvitationsController,
  ],
  providers: [
    MerchantInvitationsService,
    InvitationMailer,
    SupabaseAuthService,
    MerchantAccessGuard,
    MerchantsService,
    PayPalConnectionClient,
    PayPalAuthService,
    PayPalOnboardingService,
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
