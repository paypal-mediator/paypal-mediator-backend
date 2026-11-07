import { Inject, Injectable } from '@nestjs/common';
import {
  ENVIRONMENT,
  type Environment,
} from '../../../common/config/environment.js';
import type { Transaction } from '../../../generated/prisma/client.js';
import {
  PAYPAL_FETCH,
  PAYPAL_SANDBOX_URL,
  PayPalAuthService,
  PayPalAuthError,
} from '../../merchants/index.js';
import {
  OrderSourceError,
  type OrderInformationSource,
} from './order-information-source.js';
import { normalizePayPalOrder } from './paypal-order-normalizer.js';

@Injectable()
export class PayPalOrderSource implements OrderInformationSource {
  readonly providerId = 'PAYPAL';
  readonly sourceKind = 'PAYPAL' as const;
  readonly sourceSystem = 'paypal-sandbox:orders-v2';
  constructor(
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(PayPalAuthService) private readonly auth: PayPalAuthService,
    @Inject(PAYPAL_FETCH) private readonly fetcher: typeof fetch,
  ) {}
  supports(row: Transaction) {
    return row.environment === 'sandbox' && !!row.paypalOrderId;
  }
  async fetch(row: Transaction) {
    if (
      row.merchantId !== this.env.MERCHANT_ID ||
      !this.env.PAYPAL_CLIENT_ID ||
      !this.env.PAYPAL_CLIENT_SECRET
    )
      throw new OrderSourceError('NOT_CONFIGURED');
    if (!row.paypalOrderId || !/^[A-Z0-9]{1,36}$/.test(row.paypalOrderId))
      throw new OrderSourceError('INVALID_PAYPAL_ORDER_ID');
    const signal = AbortSignal.timeout(this.env.PAYPAL_TIMEOUT_MS);
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.auth.getAccessToken(signal, attempt === 1);
        response = await this.fetcher(
          `${PAYPAL_SANDBOX_URL}/v2/checkout/orders/${row.paypalOrderId}`,
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
        if (response.status !== 401 || attempt === 1) break;
        await response.body?.cancel();
      }
      if (!response!.ok) {
        await response!.body?.cancel();
        throw new OrderSourceError(
          'PAYPAL_ORDER_HTTP_ERROR',
          response!.status === 429 || response!.status >= 500,
          response!.status,
        );
      }
      // Stream with a bound; Content-Length alone cannot constrain chunked responses.
      const reader = response!.body?.getReader();
      if (!reader) throw new OrderSourceError('PAYPAL_ORDER_EMPTY_RESPONSE');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 1024 * 1024)
            throw new OrderSourceError('PAYPAL_ORDER_RESPONSE_TOO_LARGE');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const original = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as Record<string, unknown>;
      if (!original || Array.isArray(original) || typeof original !== 'object')
        throw new OrderSourceError('PAYPAL_ORDER_INVALID_JSON');
      return { original, result: normalizePayPalOrder(original, row) };
    } catch (error) {
      if (error instanceof OrderSourceError) throw error;
      if (error instanceof PayPalAuthError)
        throw new OrderSourceError(
          'PAYPAL_AUTH_UNAVAILABLE',
          true,
          error.httpStatus,
        );
      if (error instanceof SyntaxError)
        throw new OrderSourceError('PAYPAL_ORDER_INVALID_JSON');
      throw new OrderSourceError(
        signal.aborted ? 'PAYPAL_ORDER_TIMEOUT' : 'PAYPAL_ORDER_UNAVAILABLE',
        true,
      );
    }
  }
}
