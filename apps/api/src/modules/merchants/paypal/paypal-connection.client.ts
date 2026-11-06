import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PayPalIntegration } from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../../common/config/environment.js';

const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().positive(),
});
const DisputeListSchema = z
  .object({
    items: z.array(z.unknown()).optional(),
    links: z.array(z.unknown()).optional(),
  })
  .refine((value) => value.items !== undefined || value.links !== undefined);
const BASE_URL = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_FETCH = Symbol('PAYPAL_FETCH');
export type PayPalCheck = Pick<
  PayPalIntegration,
  | 'connectionStatus'
  | 'disputesReadStatus'
  | 'paypalHttpStatus'
  | 'paypalDebugId'
>;

@Injectable()
export class PayPalConnectionClient {
  constructor(
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PAYPAL_FETCH) private readonly fetcher: typeof fetch,
  ) {}

  get credentialsConfigured(): boolean {
    return Boolean(
      this.environment.PAYPAL_CLIENT_ID &&
      this.environment.PAYPAL_CLIENT_SECRET,
    );
  }

  get fingerprint(): string {
    // Keyed digest detects secret/client rotation without storing either credential.
    return createHmac('sha256', this.environment.PAYPAL_CLIENT_SECRET ?? '')
      .update(`sandbox:${this.environment.PAYPAL_CLIENT_ID ?? ''}`)
      .digest('hex');
  }

  private debugId(response: Response): string | null {
    const id = response.headers.get('paypal-debug-id');
    return id && /^[a-zA-Z0-9-]{1,128}$/.test(id) ? id : null;
  }

  async check(): Promise<PayPalCheck> {
    const result: PayPalCheck = {
      connectionStatus: 'UNAVAILABLE',
      disputesReadStatus: 'NOT_CHECKED',
      paypalHttpStatus: null,
      paypalDebugId: null,
    };
    if (!this.credentialsConfigured)
      return { ...result, connectionStatus: 'NOT_CONFIGURED' };
    // One deadline for the entire check, including both response bodies.
    const signal = AbortSignal.timeout(this.environment.PAYPAL_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${BASE_URL}/v1/oauth2/token`, {
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
      });
      result.paypalHttpStatus = response.status;
      result.paypalDebugId = this.debugId(response);
      if (!response.ok) {
        result.connectionStatus = [400, 401].includes(response.status)
          ? 'INVALID_CREDENTIALS'
          : 'UNAVAILABLE';
        await response.body?.cancel();
        return result;
      }
      const token = TokenSchema.safeParse(await response.json());
      if (!token.success) return result;
      result.connectionStatus = 'CONNECTED';
      result.disputesReadStatus = 'UNAVAILABLE';
      const disputes = await this.fetcher(
        `${BASE_URL}/v1/customer/disputes?page_size=1`,
        {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${token.data.access_token}`,
            Accept: 'application/json',
          },
        },
      );
      result.paypalHttpStatus = disputes.status;
      result.paypalDebugId = this.debugId(disputes);
      if (disputes.ok) {
        if (DisputeListSchema.safeParse(await disputes.json()).success)
          result.disputesReadStatus = 'AVAILABLE';
      } else {
        if ([401, 403].includes(disputes.status))
          result.disputesReadStatus = 'DENIED';
        await disputes.body?.cancel();
      }
      return result;
    } catch {
      return result;
    }
  }
}
