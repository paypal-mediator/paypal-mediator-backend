import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { parseEnvironment } from '../../src/common/config/environment.js';
import { PayPalOnboardingService } from '../../src/modules/merchants/paypal/paypal-onboarding.service.js';
import { PayPalAuthService } from '../../src/modules/merchants/paypal/paypal-auth.service.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
const actor = {
  merchantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  role: 'ADMIN' as const,
};
function setup(
  overrides: Record<string, string | undefined> = {},
  response = Response.json({
    links: [{ rel: 'action_url', href: 'https://evil.test/steal' }],
  }),
) {
  const env = parseEnvironment({
    DATABASE_URL: 'postgresql://localhost/MOCK',
    PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
    PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
    PAYPAL_PARTNER_MERCHANT_ID: 'PARTNER123456',
    PAYPAL_PARTNER_ATTRIBUTION_ID: 'MOCK_BN',
    PAYPAL_ONBOARDING_RETURN_URL: 'http://localhost:3000/',
    ...overrides,
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const upsert = vi.fn();
  const service = new PayPalOnboardingService(
    env,
    { payPalAccount: { upsert } } as unknown as PrismaService,
    {
      getAccessToken: vi.fn().mockResolvedValue({ accessToken: 'MOCK_TOKEN' }),
    } as unknown as PayPalAuthService,
    fetcher,
  );
  return { service, fetcher, upsert };
}
describe('PayPal onboarding fails closed (MOCK provider)', () => {
  it('permits Sandbox without a BN code and omits the attribution header', async () => {
    const { service, fetcher, upsert } = setup(
      { PAYPAL_PARTNER_ATTRIBUTION_ID: undefined },
      Response.json({
        links: [
          {
            rel: 'action_url',
            href: 'https://www.sandbox.paypal.com/authorize',
          },
        ],
      }),
    );
    await expect(service.start(actor)).resolves.toMatchObject({
      merchantId: actor.merchantId,
    });
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'PayPal-Partner-Attribution-Id',
    );
    expect(upsert).toHaveBeenCalledOnce();
  });
  it('rejects missing partner setup and viewers without making a provider request', async () => {
    const missing = setup({ PAYPAL_PARTNER_MERCHANT_ID: undefined });
    await expect(missing.service.start(actor)).rejects.toMatchObject({
      message: expect.stringContaining('not enabled'),
    });
    expect(missing.fetcher).not.toHaveBeenCalled();
    const viewer = setup();
    await expect(
      viewer.service.start({ ...actor, role: 'VIEWER' }),
    ).rejects.toThrow('administrator');
    expect(viewer.fetcher).not.toHaveBeenCalled();
  });
  it('rejects return URLs outside the configured frontend origins', async () => {
    const { service, fetcher } = setup({
      PAYPAL_ONBOARDING_RETURN_URL: 'https://evil.test/',
    });
    await expect(service.start(actor)).rejects.toThrow(
      'allowed frontend origin',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects untrusted PayPal redirect URLs without persisting a connection', async () => {
    const { service, upsert } = setup();
    await expect(service.start(actor)).rejects.toThrow(
      'valid authorization URL',
    );
    expect(upsert).not.toHaveBeenCalled();
  });
  it('sanitizes PayPal failures and never persists a successful connection', async () => {
    const { service, upsert } = setup(
      {},
      new Response('MOCK_PROVIDER_SECRET', { status: 403 }),
    );
    await expect(service.start(actor)).rejects.toThrow(
      'Check partner permissions',
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});
