import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Prisma, type Transaction } from '../../src/generated/prisma/client.js';
import { normalizePayPalOrder } from '../../src/modules/transactions/sources/paypal-order-normalizer.js';
import { PayPalOrderSource } from '../../src/modules/transactions/sources/paypal-order-source.js';
import { PayPalAuthService } from '../../src/modules/merchants/index.js';
import { parseEnvironment } from '../../src/common/config/environment.js';
import { mockPayPalOrder } from '../fixtures/paypal-order.js';

const row = {
  merchantId: '00000000-0000-4000-8000-000000000001',
  environment: 'sandbox',
  paypalOrderId: 'MOCKORDER',
  paypalCaptureId: 'MOCKCAPTURE',
  merchantOrderReference: 'MOCKREFERENCE',
  invoiceId: null,
  amount: new Prisma.Decimal('1.00'),
  currencyCode: 'USD',
  capturedAt: new Date('2026-11-06T00:00:00Z'),
} as Transaction;
describe('order adapters (explicit MOCK PayPal)', () => {
  it('preserves separate items, quantities, SKU, exact decimal strings and explicit zero', () => {
    const result = normalizePayPalOrder(mockPayPalOrder(), row);
    expect(result.association).toBe('MATCHED');
    expect(result.missingFields).toEqual([]);
    expect(result.order).toMatchObject({
      sourceKind: 'PAYPAL',
      totalAmount: '1.00',
      items: [
        { sku: 'MOCKA', quantity: 2, unitAmount: '0.30' },
        { sku: 'MOCKB', quantity: 1, unitAmount: '0.20' },
      ],
      breakdown: { handling: { value: '0.00' } },
    });
  });
  it('does not invent items, merchant references, invoices or missing breakdowns', () => {
    const original = mockPayPalOrder();
    const u = original.purchase_units[0]!;
    const sparse = {
      ...original,
      purchase_units: [
        {
          amount: { currency_code: 'USD', value: '1.00' },
          payments: u.payments,
        },
      ],
    };
    const result = normalizePayPalOrder(sparse, row);
    expect(result.order).toMatchObject({
      items: [],
      merchantOrderReference: null,
      invoiceId: null,
      shippingAmount: null,
      breakdown: { shipping: null, handling: null },
    });
    expect(result.missingFields).toContain('items');
  });
  it('selects the purchase unit containing the actual capture rather than the first unit', () => {
    const original = mockPayPalOrder();
    original.purchase_units.unshift({
      ...original.purchase_units[0]!,
      payments: { captures: [] },
    });
    expect(normalizePayPalOrder(original, row).association).toBe('MATCHED');
    original.purchase_units[0]!.payments = original.purchase_units[1]!.payments;
    expect(normalizePayPalOrder(original, row).association).toBe('CONFLICT');
  });
  it.each([
    'amount',
    'currency',
    'reference',
    'partial',
    'multiple',
    'identity',
    'items',
    'breakdown',
  ])('retains contradictions: %s', (kind) => {
    const original = mockPayPalOrder();
    const u = original.purchase_units[0]!;
    if (kind === 'amount') u.amount.value = '2.00';
    if (kind === 'currency') u.amount.currency_code = 'EUR';
    if (kind === 'reference') u.custom_id = 'OTHER';
    if (kind === 'partial') u.payments.captures[0]!.final_capture = false;
    if (kind === 'multiple')
      u.payments.captures.push({ ...u.payments.captures[0]!, id: 'OTHER' });
    if (kind === 'identity') original.id = 'OTHER';
    if (kind === 'items') u.items[0]!.quantity = '3';
    if (kind === 'breakdown') u.amount.breakdown.handling.value = '0.10';
    expect(normalizePayPalOrder(original, row).association).toBe('CONFLICT');
  });
  it('does not associate an order without the verified capture', () => {
    expect(
      normalizePayPalOrder(mockPayPalOrder('MOCKORDER', 'OTHER'), row),
    ).toMatchObject({ order: null, association: 'UNRESOLVED' });
    expect(
      normalizePayPalOrder({ id: 'MOCKORDER', purchase_units: 'invalid' }, row)
        .issues,
    ).toContain('INVALID_PAYPAL_ORDER_RESPONSE');
  });
  function adapter(
    fetcher: typeof fetch,
    overrides: Record<string, string> = {},
  ) {
    const env = parseEnvironment({
      DATABASE_URL: 'postgresql://localhost:1/MOCK',
      MERCHANT_ID: row.merchantId,
      PAYPAL_CLIENT_ID: 'MOCKCLIENT',
      PAYPAL_CLIENT_SECRET: 'MOCKSECRET',
      PAYPAL_TIMEOUT_MS: '100',
      ...overrides,
    });
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue({ accessToken: 'MOCKTOKEN' }),
    };
    return {
      source: new PayPalOrderSource(
        env,
        auth as unknown as PayPalAuthService,
        fetcher,
      ),
      auth,
    };
  }
  it('uses the fixed Sandbox endpoint and refreshes OAuth once after 401', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValue(Response.json(mockPayPalOrder()));
    const { source, auth } = adapter(fetcher);
    expect((await source.fetch(row)).result.association).toBe('MATCHED');
    expect(fetcher.mock.calls[0]![0]).toBe(
      'https://api-m.sandbox.paypal.com/v2/checkout/orders/MOCKORDER',
    );
    expect(auth.getAccessToken.mock.calls[1]![1]).toBe(true);
  });
  it.each([403, 404, 429, 500])(
    'reports HTTP %s without exposing response bodies',
    async (status) => {
      const { source } = adapter(
        vi.fn().mockResolvedValue(new Response('MOCK_SECRET', { status })),
      );
      await expect(source.fetch(row)).rejects.toMatchObject({
        code: 'PAYPAL_ORDER_HTTP_ERROR',
        httpStatus: status,
        retryable: status >= 500 || status === 429,
      });
    },
  );
  it('bounds responses and rejects invalid JSON', async () => {
    await expect(
      adapter(
        vi.fn().mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1))),
      ).source.fetch(row),
    ).rejects.toMatchObject({ code: 'PAYPAL_ORDER_RESPONSE_TOO_LARGE' });
    await expect(
      adapter(vi.fn().mockResolvedValue(new Response('{'))).source.fetch(row),
    ).rejects.toMatchObject({ code: 'PAYPAL_ORDER_INVALID_JSON' });
  });
  it('keeps configuration tenant scoped and rejects path injection', async () => {
    const fetcher = vi.fn();
    const { source } = adapter(fetcher);
    await expect(
      source.fetch({ ...row, merchantId: 'OTHER' }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(
      source.fetch({ ...row, paypalOrderId: '../OTHER' }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYPAL_ORDER_ID' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports timeout explicitly', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_input, init) =>
          new Promise((_resolve, reject) =>
            init!.signal!.addEventListener('abort', () =>
              reject(new Error('MOCK')),
            ),
          ),
      );
    await expect(adapter(fetcher).source.fetch(row)).rejects.toMatchObject({
      code: 'PAYPAL_ORDER_TIMEOUT',
      retryable: true,
    });
  });
});
