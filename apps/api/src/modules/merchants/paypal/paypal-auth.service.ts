import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../../common/database/prisma.service.js';
import { ApiException } from '../../../common/http/api.exception.js';
import { z } from 'zod';
import {
  ENVIRONMENT,
  type Environment,
} from '../../../common/config/environment.js';

export const PAYPAL_FETCH = Symbol('PAYPAL_FETCH');
export const PAYPAL_SANDBOX_URL = 'https://api-m.sandbox.paypal.com';
const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().positive(),
});
export interface PayPalAccessToken {
  accessToken: string;
  httpStatus: number;
  debugId: string | null;
}

export class PayPalAuthError extends Error {
  constructor(
    public readonly httpStatus: number | null,
    public readonly debugId: string | null,
  ) {
    super('PayPal authentication is unavailable');
  }
}

export function paypalDebugId(response: Response): string | null {
  const id = response.headers.get('paypal-debug-id');
  return id && /^[a-zA-Z0-9-]{1,128}$/.test(id) ? id : null;
}

@Injectable()
export class PayPalAuthService {
  private cached: { token: PayPalAccessToken; expiresAt: number } | undefined;

  constructor(
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PAYPAL_FETCH) private readonly fetcher: typeof fetch,
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
  ) {}

  async merchantHeaders(merchantId: string): Promise<Record<string, string>> {
    const account = await this.prisma?.payPalAccount.findUnique({
      where: { merchantId },
    });
    if (
      account?.status === 'CONNECTED' &&
      account.sellerId &&
      this.environment.PAYPAL_CLIENT_ID
    ) {
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      return {
        'PayPal-Auth-Assertion': `${encode({ alg: 'none' })}.${encode({ iss: this.environment.PAYPAL_CLIENT_ID, payer_id: account.sellerId })}.`,
        ...(this.environment.PAYPAL_PARTNER_ATTRIBUTION_ID
          ? {
              'PayPal-Partner-Attribution-Id':
                this.environment.PAYPAL_PARTNER_ATTRIBUTION_ID,
            }
          : {}),
      };
    }
    if (
      !account &&
      merchantId === this.environment.MERCHANT_ID &&
      !this.environment.PAYPAL_PARTNER_MERCHANT_ID
    )
      return {};
    throw new ApiException(
      'PAYPAL_NOT_CONFIGURED',
      'Connect PayPal for this business before continuing',
      409,
    );
  }

  // Server-module interface only. Tokens must never be exposed by controllers or agent tools.
  async getAccessToken(
    signal: AbortSignal,
    forceRefresh = false,
  ): Promise<PayPalAccessToken> {
    if (!forceRefresh && this.cached && this.cached.expiresAt > Date.now())
      return this.cached.token;
    if (
      !this.environment.PAYPAL_CLIENT_ID ||
      !this.environment.PAYPAL_CLIENT_SECRET
    )
      throw new PayPalAuthError(null, null);
    let status: number | null = null;
    let debugId: string | null = null;
    try {
      const response = await this.fetcher(
        `${PAYPAL_SANDBOX_URL}/v1/oauth2/token`,
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.environment.PAYPAL_CLIENT_ID}:${this.environment.PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
          }).toString(),
        },
      );
      status = response.status;
      debugId = paypalDebugId(response);
      if (!response.ok) {
        await response.body?.cancel();
        throw new PayPalAuthError(status, debugId);
      }
      const parsed = TokenSchema.safeParse(await response.json());
      if (!parsed.success) throw new PayPalAuthError(status, debugId);
      const token: PayPalAccessToken = {
        accessToken: parsed.data.access_token,
        httpStatus: status,
        debugId,
      };
      this.cached = {
        token,
        expiresAt: Date.now() + Math.max(0, parsed.data.expires_in - 30) * 1000,
      };
      return token;
    } catch {
      this.cached = undefined;
      throw new PayPalAuthError(status, debugId);
    }
  }
}
