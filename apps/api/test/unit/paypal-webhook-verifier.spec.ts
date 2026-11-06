import { describe, expect, it, vi } from 'vitest';
import { PayPalWebhookVerifier } from '../../src/modules/event-ingestion/paypal-webhook.verifier.js';
import { parseTransmissionHeaders } from '../../src/modules/event-ingestion/webhook-validation.js';
import { PayPalAuthService } from '../../src/modules/merchants/index.js';
import { parseEnvironment } from '../../src/common/config/environment.js';
import {
  mockTransmissionHeaders,
  mockWebhookEvent,
} from '../fixtures/paypal-webhook.js';

const env = parseEnvironment({
  DATABASE_URL: 'postgresql://localhost/test',
  PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
  PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const oauth = () =>
  json({ access_token: 'MOCK_TOKEN', token_type: 'Bearer', expires_in: 300 });
const headers = parseTransmissionHeaders(mockTransmissionHeaders);

describe('M02 verifier uses M01 authentication (MOCK PayPal responses)', () => {
  it('forwards the complete event with the configured webhook ID to the fixed endpoint', async () => {
    const event = { ...mockWebhookEvent(), unknown_field: { retained: true } };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauth())
      .mockResolvedValueOnce(json({ verification_status: 'SUCCESS' }));
    const verifier = new PayPalWebhookVerifier(
      env,
      new PayPalAuthService(env, fetcher),
      fetcher,
    );
    await verifier.verify(event, headers, 'MOCK-WEBHOOK');
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api-m.sandbox.paypal.com/v1/oauth2/token',
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature',
    );
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer MOCK_TOKEN',
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      ...headers,
      webhook_id: 'MOCK-WEBHOOK',
      webhook_event: event,
    });
  });
  it('rejects explicit verification failure', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauth())
      .mockResolvedValueOnce(json({ verification_status: 'FAILURE' }));
    await expect(
      new PayPalWebhookVerifier(
        env,
        new PayPalAuthService(env, fetcher),
        fetcher,
      ).verify(mockWebhookEvent(), headers, 'MOCK-WEBHOOK'),
    ).rejects.toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });
  it.each([
    () => json({ verification_status: 'UNKNOWN' }),
    () => json({ error: 'MOCK_SERVICE_FAILURE' }, 500),
    () => new Response('not json'),
  ])(
    'fails closed for unavailable or malformed verification responses',
    async (response) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(oauth())
        .mockResolvedValueOnce(response());
      await expect(
        new PayPalWebhookVerifier(
          env,
          new PayPalAuthService(env, fetcher),
          fetcher,
        ).verify(mockWebhookEvent(), headers, 'MOCK-WEBHOOK'),
      ).rejects.toMatchObject({ code: 'WEBHOOK_VERIFICATION_UNAVAILABLE' });
    },
  );
  it('does not expose authentication errors to the webhook sender', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: 'MOCK_SECRET' }, 401));
    await expect(
      new PayPalWebhookVerifier(
        env,
        new PayPalAuthService(env, fetcher),
        fetcher,
      ).verify(mockWebhookEvent(), headers, 'MOCK-WEBHOOK'),
    ).rejects.toMatchObject({ code: 'WEBHOOK_VERIFICATION_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
