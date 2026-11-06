import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PayPalWebhookEnvelope } from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { ApiException } from '../../common/http/api.exception.js';
import {
  PAYPAL_FETCH,
  PAYPAL_SANDBOX_URL,
  PayPalAuthService,
} from '../merchants/index.js';
import type { TransmissionHeaders } from './webhook-validation.js';

const VerificationSchema = z.object({
  verification_status: z.enum(['SUCCESS', 'FAILURE']),
});

@Injectable()
export class PayPalWebhookVerifier {
  constructor(
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PayPalAuthService) private readonly auth: PayPalAuthService,
    @Inject(PAYPAL_FETCH) private readonly fetcher: typeof fetch,
  ) {}

  async verify(
    event: PayPalWebhookEnvelope,
    headers: TransmissionHeaders,
    webhookId: string,
  ): Promise<void> {
    const signal = AbortSignal.timeout(this.environment.PAYPAL_TIMEOUT_MS);
    try {
      // Fresh credentials on each delivery; a revoked cached token cannot block retries.
      const token = await this.auth.getAccessToken(signal, true);
      const response = await this.fetcher(
        `${PAYPAL_SANDBOX_URL}/v1/notifications/verify-webhook-signature`,
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            ...headers,
            webhook_id: webhookId,
            webhook_event: event,
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Verification service unavailable');
      }
      const result = VerificationSchema.safeParse(await response.json());
      if (!result.success) throw new Error('Invalid verification response');
      if (result.data.verification_status === 'FAILURE')
        throw new ApiException(
          'INVALID_WEBHOOK_SIGNATURE',
          'The PayPal webhook signature is invalid',
          401,
        );
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException(
        'WEBHOOK_VERIFICATION_UNAVAILABLE',
        'PayPal webhook verification is unavailable; retry delivery',
        503,
      );
    }
  }
}
