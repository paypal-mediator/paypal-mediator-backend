import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ENVIRONMENT,
  type Environment,
} from '../../../common/config/environment.js';
import { PrismaService } from '../../../common/database/prisma.service.js';
import { ApiException } from '../../../common/http/api.exception.js';
import type { MerchantActor } from '../auth/merchant-access.guard.js';
import {
  PAYPAL_FETCH,
  PAYPAL_SANDBOX_URL,
  PayPalAuthService,
} from './paypal-auth.service.js';

const SellerSchema = z.object({
  merchant_id: z.string().regex(/^[A-Z0-9]{13}$/),
  tracking_id: z.uuid(),
  primary_email_confirmed: z.boolean(),
  oauth_integrations: z
    .array(
      z.object({
        oauth_third_party: z
          .array(
            z.object({
              partner_client_id: z.string(),
              scopes: z.array(z.string()),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

@Injectable()
export class PayPalOnboardingService {
  constructor(
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PayPalAuthService) private readonly auth: PayPalAuthService,
    @Inject(PAYPAL_FETCH) private readonly fetcher: typeof fetch,
  ) {}

  get available() {
    return Boolean(
      this.env.PAYPAL_CLIENT_ID &&
      this.env.PAYPAL_CLIENT_SECRET &&
      this.env.PAYPAL_PARTNER_MERCHANT_ID &&
      this.env.PAYPAL_ONBOARDING_RETURN_URL,
    );
  }

  private requireAdmin(actor: MerchantActor) {
    if (actor.role !== 'ADMIN')
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'A merchant administrator is required',
        403,
      );
    if (!this.available)
      throw new ApiException(
        'PAYPAL_ONBOARDING_NOT_CONFIGURED',
        'PayPal account connection is not enabled. Contact the administrator to configure the PayPal partner integration.',
        409,
      );
  }

  private async request(path: string, body?: unknown) {
    const signal = AbortSignal.timeout(this.env.PAYPAL_TIMEOUT_MS);
    try {
      const token = await this.auth.getAccessToken(signal);
      const response = await this.fetcher(`${PAYPAL_SANDBOX_URL}${path}`, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
          ...(this.env.PAYPAL_PARTNER_ATTRIBUTION_ID
            ? {
                'PayPal-Partner-Attribution-Id':
                  this.env.PAYPAL_PARTNER_ATTRIBUTION_ID,
              }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      return (await response.json()) as unknown;
    } catch {
      throw new ApiException(
        'PAYPAL_ONBOARDING_UNAVAILABLE',
        'PayPal could not complete the connection. Check partner permissions or try again.',
        502,
      );
    }
  }

  async start(actor: MerchantActor) {
    this.requireAdmin(actor);
    const returnUrl = new URL(this.env.PAYPAL_ONBOARDING_RETURN_URL!);
    if (
      !this.env.CORS_ORIGIN.includes(returnUrl.origin) ||
      (this.env.NODE_ENV === 'production' && returnUrl.protocol !== 'https:')
    )
      throw new ApiException(
        'PAYPAL_ONBOARDING_NOT_CONFIGURED',
        'PayPal return URL must use an allowed frontend origin',
        409,
      );
    const trackingId = randomUUID();
    returnUrl.searchParams.set('paypalReturn', actor.merchantId);
    const result = z
      .object({ links: z.array(z.object({ rel: z.string(), href: z.url() })) })
      .parse(
        await this.request('/v2/customer/partner-referrals', {
          tracking_id: trackingId,
          operations: [
            {
              operation: 'API_INTEGRATION',
              api_integration_preference: {
                rest_api_integration: {
                  integration_method: 'PAYPAL',
                  integration_type: 'THIRD_PARTY',
                  third_party_details: {
                    features: ['READ_SELLER_DISPUTE', 'UPDATE_SELLER_DISPUTE'],
                  },
                },
              },
            },
          ],
          products: ['EXPRESS_CHECKOUT'],
          legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
          partner_config_override: { return_url: returnUrl.toString() },
        }),
      );
    const actionUrl = result.links.find(
      (link) => link.rel === 'action_url',
    )?.href;
    if (
      !actionUrl ||
      new URL(actionUrl).origin !== 'https://www.sandbox.paypal.com'
    )
      throw new ApiException(
        'PAYPAL_ONBOARDING_UNAVAILABLE',
        'PayPal did not return a valid authorization URL',
        502,
      );
    await this.prisma.payPalAccount.upsert({
      where: { merchantId: actor.merchantId },
      create: {
        merchantId: actor.merchantId,
        trackingId,
        expiresAt: new Date(Date.now() + 3600000),
      },
      update: { trackingId, expiresAt: new Date(Date.now() + 3600000) },
    });
    return { actionUrl, merchantId: actor.merchantId };
  }

  async complete(actor: MerchantActor) {
    this.requireAdmin(actor);
    const pending = await this.prisma.payPalAccount.findUnique({
      where: { merchantId: actor.merchantId },
    });
    if (!pending || pending.expiresAt < new Date())
      throw new ApiException(
        'PAYPAL_ONBOARDING_EXPIRED',
        'Start a new PayPal connection and authorize it before checking again',
        409,
      );
    // Never trust seller IDs or consent flags from browser query parameters.
    const raw = await this.request(
      `/v1/customer/partners/${this.env.PAYPAL_PARTNER_MERCHANT_ID}/merchant-integrations?tracking_id=${pending.trackingId}`,
    );
    const tracked = z
      .object({
        merchant_id: z.string().regex(/^[A-Z0-9]{13}$/),
        tracking_id: z.uuid(),
      })
      .safeParse(raw);
    if (!tracked.success || tracked.data.tracking_id !== pending.trackingId)
      throw new ApiException(
        'PAYPAL_CONSENT_PENDING',
        'Complete PayPal authorization before checking again',
        409,
      );
    const seller = SellerSchema.safeParse(
      await this.request(
        `/v1/customer/partners/${this.env.PAYPAL_PARTNER_MERCHANT_ID}/merchant-integrations/${tracked.data.merchant_id}`,
      ),
    );
    if (
      !seller.success ||
      seller.data.merchant_id !== tracked.data.merchant_id ||
      seller.data.tracking_id !== pending.trackingId ||
      !seller.data.primary_email_confirmed ||
      !seller.data.oauth_integrations?.some((integration) =>
        integration.oauth_third_party?.some(
          (grant) =>
            grant.partner_client_id === this.env.PAYPAL_CLIENT_ID &&
            [
              'https://uri.paypal.com/services/disputes/read-seller',
              'https://uri.paypal.com/services/disputes/update-seller',
            ].every((scope) => grant.scopes.includes(scope)),
        ),
      )
    )
      throw new ApiException(
        'PAYPAL_CONSENT_PENDING',
        'Complete PayPal authorization, confirm your email and grant access to seller disputes, then check again.',
        409,
      );
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.payPalAccount.update({
          where: {
            merchantId: actor.merchantId,
            trackingId: pending.trackingId,
            expiresAt: { gt: new Date() },
          },
          data: {
            sellerId: seller.data.merchant_id,
            status: 'CONNECTED',
            checkedAt: new Date(),
          },
        });
        await tx.merchantIntegration.deleteMany({
          where: { merchantId: actor.merchantId },
        });
        await tx.merchantEvent.create({
          data: {
            merchantId: actor.merchantId,
            actorUserId: actor.userId,
            action: 'PAYPAL_CONNECTED',
            details: { sellerId: seller.data.merchant_id },
          },
        });
      });
    } catch {
      throw new ApiException(
        'PAYPAL_ACCOUNT_CONFLICT',
        'This PayPal account is already linked or the connection attempt changed. Start again.',
        409,
      );
    }
    return { connected: true };
  }

  async disconnect(actor: MerchantActor) {
    if (actor.role !== 'ADMIN')
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'A merchant administrator is required',
        403,
      );
    await this.prisma.$transaction(async (tx) => {
      await tx.payPalAccount.updateMany({
        where: { merchantId: actor.merchantId },
        data: {
          status: 'DISCONNECTED',
          sellerId: null,
          expiresAt: new Date(0),
        },
      });
      await tx.merchantEvent.create({
        data: {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          action: 'PAYPAL_DISCONNECTED',
          details: {},
        },
      });
    });
    return { connected: false };
  }
}
