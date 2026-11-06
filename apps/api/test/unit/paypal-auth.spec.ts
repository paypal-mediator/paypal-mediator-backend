import { describe, expect, it, vi } from 'vitest';
import { PayPalAuthService } from '../../src/modules/merchants/paypal/paypal-auth.service.js';
import { parseEnvironment } from '../../src/common/config/environment.js';

const env = parseEnvironment({
  DATABASE_URL: 'postgresql://localhost/test',
  PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
  PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
});
const token = (expires = 300) =>
  new Response(
    JSON.stringify({
      access_token: 'MOCK_TOKEN',
      token_type: 'Bearer',
      expires_in: expires,
    }),
  );

describe('M01 public PayPal authentication (MOCK responses)', () => {
  it('caches tokens for module consumers and explicitly refreshes connection checks', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => token());
    const service = new PayPalAuthService(env, fetcher);
    const signal = AbortSignal.timeout(5000);
    await service.getAccessToken(signal);
    await service.getAccessToken(signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await service.getAccessToken(signal, true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not cache tokens close to expiry', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => token(10));
    const service = new PayPalAuthService(env, fetcher);
    await service.getAccessToken(AbortSignal.timeout(5000));
    await service.getAccessToken(AbortSignal.timeout(5000));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('sanitizes network errors before sharing them with other modules', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('MOCK_SECRET'));
    await expect(
      new PayPalAuthService(env, fetcher).getAccessToken(
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({
      message: 'PayPal authentication is unavailable',
      httpStatus: null,
    });
  });
});
