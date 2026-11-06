import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PayPalIntegration } from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../../common/config/environment.js';
import {
  PAYPAL_FETCH,
  PAYPAL_SANDBOX_URL,
  PayPalAuthService,
  PayPalAuthError,
  paypalDebugId,
} from './paypal-auth.service.js';
export { PAYPAL_FETCH } from './paypal-auth.service.js';
const DisputeListSchema = z
  .object({
    items: z.array(z.unknown()).optional(),
    links: z.array(z.unknown()).optional(),
  })
  .refine((value) => value.items !== undefined || value.links !== undefined);
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
    @Inject(PayPalAuthService)
    private readonly auth: PayPalAuthService = new PayPalAuthService(
      environment,
      fetcher,
    ),
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
      const token = await this.auth.getAccessToken(signal, true);
      result.paypalHttpStatus = token.httpStatus;
      result.paypalDebugId = token.debugId;
      result.connectionStatus = 'CONNECTED';
      result.disputesReadStatus = 'UNAVAILABLE';
      const disputes = await this.fetcher(
        `${PAYPAL_SANDBOX_URL}/v1/customer/disputes?page_size=1`,
        {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            Accept: 'application/json',
          },
        },
      );
      result.paypalHttpStatus = disputes.status;
      result.paypalDebugId = paypalDebugId(disputes);
      if (disputes.ok) {
        if (DisputeListSchema.safeParse(await disputes.json()).success)
          result.disputesReadStatus = 'AVAILABLE';
      } else {
        if ([401, 403].includes(disputes.status))
          result.disputesReadStatus = 'DENIED';
        await disputes.body?.cancel();
      }
      return result;
    } catch (error) {
      if (error instanceof PayPalAuthError) {
        result.paypalHttpStatus = error.httpStatus;
        result.paypalDebugId = error.debugId;
        result.connectionStatus =
          error.httpStatus !== null && [400, 401].includes(error.httpStatus)
            ? 'INVALID_CREDENTIALS'
            : 'UNAVAILABLE';
      }
      return result;
    }
  }
}
