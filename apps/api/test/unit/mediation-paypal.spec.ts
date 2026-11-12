import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  MediationPayPalClient,
  PayPalMediationDetailSchema,
} from '../../src/modules/submissions/mediation-paypal.client.js';
import { PayPalAuthService } from '../../src/modules/merchants/index.js';
import { parseEnvironment } from '../../src/common/config/environment.js';
const merchantId = '00000000-0000-4000-8000-000000000001';
const env = parseEnvironment({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/test',
  MERCHANT_ID: merchantId,
});
const raw = {
  dispute_id: 'PP-D-MOCK',
  create_time: '2026-11-01T00:00:00Z',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  dispute_life_cycle_stage: 'INQUIRY',
  disputed_transactions: [{ seller_transaction_id: 'CAPTURE-MOCK' }],
  links: [
    {
      rel: 'send-message',
      method: 'POST',
      href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-MOCK/send-message',
    },
  ],
};
function setup(
  fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(raw)),
) {
  const auth = {
    getAccessToken: vi.fn().mockResolvedValue({ accessToken: 'MOCK_TOKEN' }),
  } as unknown as PayPalAuthService;
  return { client: new MediationPayPalClient(fetcher, auth, env), fetcher };
}
describe('PayPal mediation adapter: strict nonfinancial allowlist', () => {
  it('retrieves bounded original files only from authenticated PayPal document paths', async () => {
    const url =
      'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-MOCK/documents/FILE';
    const bytes = Buffer.from('%PDF-1.4 MOCK ORIGINAL');
    const { client, fetcher } = setup(
      vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(bytes, {
            headers: { 'content-type': 'application/pdf' },
          }),
      ),
    );
    const file = await client.document(merchantId, 'PP-D-MOCK', url);
    expect(file.bytes).toEqual(bytes);
    expect(file.sha256).toHaveLength(64);
    const detail = PayPalMediationDetailSchema.parse({
      ...raw,
      evidences: [{ evidence_type: 'OTHER', documents: [{ url }] }],
    });
    expect(await client.documents(merchantId, detail)).toHaveLength(1);
    const count = fetcher.mock.calls.length;
    for (const bad of [
      'https://evil.test/x',
      url.replace('PP-D-MOCK', 'OTHER'),
      url + '?secret=x',
      url + '#fragment',
      url.replace('FILE', '%2fprivate'),
    ])
      await expect(
        client.document(merchantId, 'PP-D-MOCK', bad),
      ).rejects.toThrow('securely retrieved');
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it('fails closed on inaccessible, oversized, active or invalid PayPal originals', async () => {
    const url =
      'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-MOCK/documents/FILE';
    for (const response of [
      new Response('denied', { status: 403 }),
      new Response('bad'),
      new Response(Buffer.from('%PDF-1.4 /JavaScript'), {
        headers: { 'content-type': 'application/pdf' },
      }),
      new Response('x'.repeat(512 * 1024 + 1), {
        headers: { 'content-type': 'image/png' },
      }),
    ])
      await expect(
        setup(
          vi.fn<typeof fetch>().mockResolvedValue(response),
        ).client.document(merchantId, 'PP-D-MOCK', url),
      ).rejects.toThrow('securely retrieved');
  });
  it('retrieves and validates the actual dispute and sender roles', async () => {
    const { client, fetcher } = setup();
    const detail = await client.detail(merchantId, 'PP-D-MOCK');
    expect(detail.messages).toEqual([]);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
    expect(
      PayPalMediationDetailSchema.safeParse({
        ...raw,
        messages: [
          {
            posted_by: 'USER',
            content: 'faked',
            time_posted: new Date().toISOString(),
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('blocks cross merchant credentials before making requests', async () => {
    const { client, fetcher } = setup();
    await expect(
      client.detail(crypto.randomUUID(), 'PP-D-MOCK'),
    ).rejects.toThrow('not configured');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('blocks invalid IDs, mismatched IDs and unbounded responses', async () => {
    await expect(
      setup().client.detail(merchantId, '../payments'),
    ).rejects.toThrow('verified PayPal');
    await expect(
      setup(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ ...raw, dispute_id: 'OTHER' })),
      ).client.detail(merchantId, 'PP-D-MOCK'),
    ).rejects.toThrow();
    await expect(
      setup(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('x'.repeat(513 * 1024))),
      ).client.detail(merchantId, 'PP-D-MOCK'),
    ).rejects.toThrow();
  });
  it('rejects failures and invalid JSON without logging sensitive upstream bodies', async () => {
    for (const response of [
      new Response('secret', { status: 500 }),
      new Response('{bad json'),
      new Response(null),
    ]) {
      await expect(
        setup(vi.fn<typeof fetch>().mockResolvedValue(response)).client.detail(
          merchantId,
          'PP-D-MOCK',
        ),
      ).rejects.toThrow('Unable to retrieve');
    }
  });
  it('allows only an exact trusted current HATEOAS action', async () => {
    const { client, fetcher } = setup(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({})),
    );
    const detail = PayPalMediationDetailSchema.parse(raw);
    await client.perform(
      merchantId,
      detail,
      'send-message',
      { message: 'MOCK' },
      'key',
    );
    expect(fetcher.mock.calls[0]![0]).toBe(raw.links[0]!.href);
    expect(fetcher.mock.calls[0]![1]?.method).toBe('POST');
    await expect(
      client.perform(
        merchantId,
        {
          ...detail,
          links: [{ ...detail.links[0]!, href: 'https://evil.test/refund' }],
        },
        'send-message',
        {},
        'key',
      ),
    ).rejects.toThrow('does not currently permit');
    await expect(
      client.perform(
        merchantId,
        { ...detail, status: 'RESOLVED' },
        'send-message',
        {},
        'key',
      ),
    ).rejects.toThrow();
    await expect(
      client.perform(merchantId, detail, 'refund' as 'send-message', {}, 'key'),
    ).rejects.toThrow('Financial operations');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry timeouts or accept non-200 responses as success', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('MOCK timeout'));
    await expect(
      setup(fetcher).client.perform(
        merchantId,
        PayPalMediationDetailSchema.parse(raw),
        'send-message',
        {},
        'key',
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      setup(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 202 })),
      ).client.perform(
        merchantId,
        PayPalMediationDetailSchema.parse(raw),
        'send-message',
        {},
        'key',
      ),
    ).rejects.toThrow('acknowledge');
  });
});
