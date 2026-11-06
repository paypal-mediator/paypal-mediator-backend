import { describe, expect, it, vi } from 'vitest';
import { PayPalConnectionClient } from '../../src/modules/merchants/paypal/paypal-connection.client.js';
import { parseEnvironment } from '../../src/common/config/environment.js';

const env = parseEnvironment({
  DATABASE_URL: 'postgresql://localhost/test',
  PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
  PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'paypal-debug-id': 'MOCK-DEBUG-123' },
  });
const oauth = () =>
  json({
    access_token: 'MOCK_ACCESS_TOKEN',
    token_type: 'Bearer',
    expires_in: 300,
  });

describe('PayPal connection client (all PayPal responses explicitly MOCK)', () => {
  it('authenticates and probes only Sandbox read access without returning secrets', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauth())
      .mockResolvedValueOnce(json({ items: [] }));
    const result = await new PayPalConnectionClient(env, fetcher).check();
    expect(result).toMatchObject({
      connectionStatus: 'CONNECTED',
      disputesReadStatus: 'AVAILABLE',
      paypalHttpStatus: 200,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api-m.sandbox.paypal.com/v1/oauth2/token',
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: 'grant_type=client_credentials',
      redirect: 'error',
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      'https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=1',
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer MOCK_ACCESS_TOKEN' },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /MOCK_ACCESS_TOKEN|MOCK_SECRET|MOCK_CLIENT/,
    );
  });
  it('does not imply read or write permission from OAuth success', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauth())
      .mockResolvedValueOnce(json({ message: 'MOCK DENIED' }, 403));
    expect(
      await new PayPalConnectionClient(env, fetcher).check(),
    ).toMatchObject({
      connectionStatus: 'CONNECTED',
      disputesReadStatus: 'DENIED',
      paypalHttpStatus: 403,
    });
  });
  it.each([400, 401])(
    'handles OAuth rejection %s without probing disputes',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ error: 'MOCK_INVALID_CLIENT' }, status));
      expect(
        await new PayPalConnectionClient(env, fetcher).check(),
      ).toMatchObject({
        connectionStatus: 'INVALID_CREDENTIALS',
        disputesReadStatus: 'NOT_CHECKED',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('fails closed for malformed token responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: 'MOCK_INCOMPLETE' }));
    expect(
      await new PayPalConnectionClient(env, fetcher).check(),
    ).toMatchObject({ connectionStatus: 'UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('handles network failure without exposing the thrown error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('MOCK_SECRET network error'));
    const result = await new PayPalConnectionClient(env, fetcher).check();
    expect(result.connectionStatus).toBe('UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('MOCK_SECRET');
  });
  it('keeps OAuth status distinct when the read probe fails', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauth())
      .mockRejectedValueOnce(new Error('MOCK_TIMEOUT'));
    expect(
      await new PayPalConnectionClient(env, fetcher).check(),
    ).toMatchObject({
      connectionStatus: 'CONNECTED',
      disputesReadStatus: 'UNAVAILABLE',
    });
  });
  it('does not call PayPal when credentials are missing', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new PayPalConnectionClient(
      parseEnvironment({ DATABASE_URL: 'postgresql://localhost/test' }),
      fetcher,
    );
    expect((await client.check()).connectionStatus).toBe('NOT_CONFIGURED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not mark malformed successful read responses as available', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauth())
      .mockResolvedValueOnce(json({ error: 'MOCK_BAD_BODY' }));
    expect(
      await new PayPalConnectionClient(env, fetcher).check(),
    ).toMatchObject({
      connectionStatus: 'CONNECTED',
      disputesReadStatus: 'UNAVAILABLE',
    });
  });

  it('bounds a hanging network request with the configured deadline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('MOCK_TIMEOUT')),
            { once: true },
          );
        }),
    );
    expect(
      (
        await new PayPalConnectionClient(
          { ...env, PAYPAL_TIMEOUT_MS: 100 },
          fetcher,
        ).check()
      ).connectionStatus,
    ).toBe('UNAVAILABLE');
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it('invalidates stored checks after either credential changes', () => {
    const first = new PayPalConnectionClient(env, fetch);
    expect(
      new PayPalConnectionClient(
        { ...env, PAYPAL_CLIENT_SECRET: 'MOCK_ROTATED' },
        fetch,
      ).fingerprint,
    ).not.toBe(first.fingerprint);
    expect(
      new PayPalConnectionClient(
        { ...env, PAYPAL_CLIENT_ID: 'MOCK_OTHER_CLIENT' },
        fetch,
      ).fingerprint,
    ).not.toBe(first.fingerprint);
  });
});
