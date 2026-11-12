import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  ResolveShipmentTrackingSchema,
  ShipmentObservationSchema,
} from '@resolve-ai/contracts';
import { PayPalOrderSource } from '../../src/modules/transactions/index.js';
import { parseEnvironment } from '../../src/common/config/environment.js';
import { SeventeenTrackClient } from '../../src/modules/shipment-tracking/seventeentrack.client.js';
import {
  normalize17Track,
  normalizeErp,
  discrepancies,
  useful,
} from '../../src/modules/shipment-tracking/tracking-normalization.js';
import {
  mock17Track,
  mock17Envelope,
  mock17Rejected,
} from '../fixtures/shipment-tracking.js';

const env = () =>
  parseEnvironment({
    DATABASE_URL: 'postgresql://localhost:1/MOCK',
    SEVENTEENTRACK_API_KEY: 'MOCK_PRIVATE_TOKEN',
  });
describe('17TRACK v2.4 HTTP contract (MOCK)', () => {
  it('uses the exact endpoints, 17token and array payload; omits carrier for auto detection', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          mock17Envelope({
            number: 'MOCKGUIDE123',
            carrier: 100003,
            origin: 1,
          }),
        ),
      )
      .mockResolvedValueOnce(Response.json(mock17Envelope(mock17Track())));
    const client = new SeventeenTrackClient(env(), fetcher);
    await client.request('register', 'MOCKGUIDE123', undefined, {
      destination_postal_code: '12345',
    });
    await client.request('gettrackinfo', 'MOCKGUIDE123', 100003);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api.17track.net/track/v2.4/register',
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { '17token': 'MOCK_PRIVATE_TOKEN' },
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual([
      { number: 'MOCKGUIDE123', destination_postal_code: '12345' },
    ]);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual([
      { number: 'MOCKGUIDE123', carrier: 100003 },
    ]);
  });
  it.each([
    [-18019903, 'TRACK17_CARRIER_NOT_DETECTED'],
    [-18019901, 'TRACK17_ALREADY_REGISTERED'],
    [-18019908, 'TRACK17_QUOTA_EXHAUSTED'],
    [-18010019, 'TRACK17_ADDITIONAL_FIELDS_REQUIRED'],
  ])(
    'handles per-number errors %s without exposing provider messages',
    async (code, name) => {
      const client = new SeventeenTrackClient(
        env(),
        vi
          .fn()
          .mockResolvedValue(
            Response.json(mock17Rejected('MOCKGUIDE123', code)),
          ),
      );
      await expect(
        client.request('register', 'MOCKGUIDE123'),
      ).rejects.toMatchObject({
        code: name,
        providerCode: code,
        retryable: false,
      });
    },
  );
  it('preserves Retry-After and leaves durable bounded retries to the job', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('MOCKSECRET', {
        status: 429,
        headers: { 'Retry-After': '120' },
      }),
    );
    await expect(
      new SeventeenTrackClient(env(), fetcher).request(
        'gettrackinfo',
        'MOCKGUIDE123',
      ),
    ).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 120000,
      code: 'TRACK17_HTTP_429',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('handles temporary network failure and missing configuration', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('MOCK_PRIVATE_TOKEN'));
    await expect(
      new SeventeenTrackClient(env(), fetcher).request(
        'register',
        'MOCKGUIDE123',
      ),
    ).rejects.toMatchObject({ code: 'TRACK17_UNAVAILABLE', retryable: true });
    const noKey = parseEnvironment({
      DATABASE_URL: 'postgresql://localhost:1/MOCK',
    });
    await expect(
      new SeventeenTrackClient(noKey, fetcher).request(
        'register',
        'MOCKGUIDE123',
      ),
    ).rejects.toMatchObject({ code: 'TRACK17_NOT_CONFIGURED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong guides, ambiguous carriers and malformed responses', async () => {
    for (const payload of [
      mock17Envelope(mock17Track('OTHER123')),
      {
        code: 0,
        data: {
          accepted: [mock17Track(), { ...mock17Track(), carrier: 3011 }],
          rejected: [],
        },
      },
      { code: 0, data: { accepted: 'bad' } },
    ]) {
      const client = new SeventeenTrackClient(
        env(),
        vi.fn().mockResolvedValue(Response.json(payload)),
      );
      await expect(
        client.request('gettrackinfo', 'MOCKGUIDE123'),
      ).rejects.toMatchObject({ retryable: false });
    }
  });
});
describe('shipment normalization and freshness', () => {
  it('retains chronological events and explicit reported delivery, never documental proof', () => {
    const raw = mock17Track();
    const old = {
      ...raw.track_info.latest_event,
      time_utc: '2026-01-01T10:00:00Z',
      stage: 'InTransit',
    };
    raw.track_info.tracking.providers[0]!.events.push(old);
    const result = normalize17Track(raw);
    expect(result).toMatchObject({
      source: '17track',
      status: 'DELIVERED',
      deliveryReported: true,
      documentaryProof: false,
      carrierCode: 100003,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.status).toBe('IN_TRANSIT');
    expect(result.deliveredAt).toBe(raw.track_info.latest_event.time_utc);
    expect(useful(result, 72)).toBe(true);
  });
  it('keeps unknown and stale data distinct; does not invent times or accept future scans', () => {
    const raw = mock17Track(
      'MOCKGUIDE123',
      'InTransit',
      '2026-01-01T00:00:00Z',
    );
    expect(useful(normalize17Track(raw), 72)).toBe(false);
    raw.track_info.latest_event.time_utc = '2099-01-01T00:00:00Z';
    raw.track_info.latest_event.time_iso = '2099-01-01T00:00:00Z';
    expect(normalize17Track(raw).events).toEqual([]);
    expect(
      normalize17Track({
        number: 'MOCKGUIDE123',
        carrier: 100003,
        track_info: null,
      }),
    ).toMatchObject({ status: 'UNKNOWN', events: [], updatedAt: null });
  });
  it('blocks uncertain carrier guesses, failed synchronization and DEMO from being sufficient', () => {
    expect(useful(normalize17Track(mock17Track(), 3), 72)).toBe(false);
    const raw = mock17Track();
    raw.track_info.tracking.providers[0]!.latest_sync_status = 'Failed';
    expect(normalize17Track(raw).issues).toContain('CARRIER_SYNC_UNSUCCESSFUL');
    expect(
      useful({ ...normalize17Track(mock17Track()), containsDemo: true }, 72),
    ).toBe(false);
  });
  it('normalizes ERP events and reports contradictory later source states', () => {
    const time = new Date().toISOString();
    const erp = normalizeErp(
      {
        trackingNumber: 'MOCKGUIDE123',
        carrier: 'MOCK Carrier',
        status: 'IN_TRANSIT',
        events: [
          { occurredAt: time, status: 'IN_TRANSIT', description: 'MOCK scan' },
        ],
      },
      'erp:MOCK',
      false,
    )!;
    const delivered = normalize17Track(
      mock17Track('MOCKGUIDE123', 'Delivered', time),
    );
    expect(erp.status).toBe('IN_TRANSIT');
    expect(discrepancies([delivered, erp])).toContain(
      'SOURCE_STATUS_CONFLICT:17track:erp:MOCKGUIDE123',
    );
    expect(ShipmentObservationSchema.parse(delivered).documentaryProof).toBe(
      false,
    );
  });
  it('validates manual guide and carrier overrides and rejects invented source provenance', () => {
    expect(
      ResolveShipmentTrackingSchema.safeParse({ trackingNumber: '' }).success,
    ).toBe(false);
    expect(
      ResolveShipmentTrackingSchema.safeParse({
        trackingNumber: 'https://secret',
        source: 'paypal',
      }).success,
    ).toBe(false);
    expect(
      ResolveShipmentTrackingSchema.parse({
        trackingNumber: 'RR123456789CN',
        carrierCode: 3011,
      }),
    ).toEqual({ trackingNumber: 'RR123456789CN', carrierCode: 3011 });
  });
});

// Exercise the real PayPal read adapter against documented MOCK responses.
describe('PayPal tracking lookup (MOCK HTTP)', () => {
  it('discovers capture-specific trackers and reads shipping v1 with the existing OAuth transport', async () => {
    const { PayPalTrackingSource } =
      await import('../../src/modules/shipment-tracking/paypal-tracking.source.js');
    const environment = parseEnvironment({
      DATABASE_URL: 'postgresql://localhost:1/MOCK',
      MERCHANT_ID: '00000000-0000-4000-8000-000000000001',
      PAYPAL_CLIENT_ID: 'MOCK',
      PAYPAL_CLIENT_SECRET: 'MOCK',
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: 'MOCKORDER',
          purchase_units: [
            {
              payments: { captures: [{ id: 'MOCKCAPTURE' }] },
              shipping: { trackers: [{ id: 'MOCKCAPTURE-MOCKGUIDE123' }] },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          transaction_id: 'MOCKCAPTURE',
          tracking_number: 'MOCKGUIDE123',
          status: 'SHIPPED',
          carrier: 'FEDEX',
          last_updated_time: new Date().toISOString(),
        }),
      );
    const { PayPalAuthService } =
      await import('../../src/modules/merchants/index.js');
    const auth = new PayPalAuthService(environment, vi.fn());
    vi.spyOn(auth, 'getAccessToken').mockResolvedValue({
      accessToken: 'MOCK_OAUTH',
      httpStatus: 200,
      debugId: null,
    });
    const source = new PayPalTrackingSource(
      new PayPalOrderSource(environment, auth, fetcher),
    );
    const row = {
      merchantId: environment.MERCHANT_ID!,
      paypalOrderId: 'MOCKORDER',
      paypalCaptureId: 'MOCKCAPTURE',
      environment: 'sandbox',
    } as import('../../src/generated/prisma/client.js').Transaction;
    const result = await source.fetch(row);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      'https://api-m.sandbox.paypal.com/v2/checkout/orders/MOCKORDER',
      'https://api-m.sandbox.paypal.com/v1/shipping/trackers/MOCKCAPTURE-MOCKGUIDE123',
    ]);
    expect(result[0]?.observation).toMatchObject({
      source: 'paypal',
      trackingNumber: 'MOCKGUIDE123',
      status: 'IN_TRANSIT',
      documentaryProof: false,
    });
    expect(useful(result[0]!.observation, 72)).toBe(true);
    expect(fetcher.mock.calls.every((c) => c[1]?.method === 'GET')).toBe(true);
  });
  it('does not treat a status without its update time as fresh tracking evidence', async () => {
    const { PayPalTrackingSource } =
      await import('../../src/modules/shipment-tracking/paypal-tracking.source.js');
    const paypal = {
      getShipmentTracker: vi.fn().mockResolvedValue({
        transaction_id: 'MOCKCAPTURE',
        tracking_number: 'MOCKGUIDE123',
        status: 'SHIPPED',
        carrier: 'FEDEX',
      }),
    };
    const source = new PayPalTrackingSource(
      paypal as unknown as InstanceType<typeof PayPalOrderSource>,
    );
    const row = {
      paypalCaptureId: 'MOCKCAPTURE',
    } as import('../../src/generated/prisma/client.js').Transaction;
    const result = await source.fetch(row, 'MOCKGUIDE123');
    expect(result[0]?.observation.updatedAt).toBeNull();
    expect(useful(result[0]!.observation, 72)).toBe(false);
  });
  it('treats mismatched capture/guide identities as a controlled error', async () => {
    const { PayPalTrackingSource } =
      await import('../../src/modules/shipment-tracking/paypal-tracking.source.js');
    const paypal = {
      getShipmentTracker: vi.fn().mockResolvedValue({
        transaction_id: 'OTHER',
        tracking_number: 'MOCKGUIDE123',
        status: 'SHIPPED',
      }),
    };
    const source = new PayPalTrackingSource(
      paypal as unknown as InstanceType<typeof PayPalOrderSource>,
    );
    await expect(
      source.fetch(
        {
          paypalCaptureId: 'MOCKCAPTURE',
        } as import('../../src/generated/prisma/client.js').Transaction,
        'MOCKGUIDE123',
      ),
    ).rejects.toMatchObject({ code: 'PAYPAL_TRACKING_IDENTITY_MISMATCH' });
  });
});
