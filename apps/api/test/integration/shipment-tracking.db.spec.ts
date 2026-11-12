import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';
import { type ShipmentObservation } from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { TransactionsService } from '../../src/modules/transactions/index.js';
import { DisputesService } from '../../src/modules/disputes/index.js';
import { IntegrationsService } from '../../src/modules/integrations/index.js';
import { ShipmentTrackingService } from '../../src/modules/shipment-tracking/index.js';
import { PayPalTrackingSource } from '../../src/modules/shipment-tracking/paypal-tracking.source.js';
import { TrackingRegistrationService } from '../../src/modules/shipment-tracking/tracking-registration.service.js';
import { ShipmentTrackingWorker } from '../../src/modules/shipment-tracking/shipment-tracking.worker.js';
import { contentHash } from '../../src/common/data/content-hash.js';
import { normalize17Track } from '../../src/modules/shipment-tracking/tracking-normalization.js';
import { createMockAuth } from '../fixtures/auth.js';
import { captureEvent } from '../fixtures/capture.js';
import { disputeEvent } from '../fixtures/dispute.js';
import { mockTransmissionHeaders } from '../fixtures/paypal-webhook.js';
import {
  mock17Track,
  mock17Envelope,
  mock17Rejected,
} from '../fixtures/shipment-tracking.js';

describe('shipment fallback: PostgreSQL and HTTP, MOCK PayPal/ERP/17TRACK/JWKS', () => {
  const merchantId = randomUUID(),
    userId = randomUUID(),
    viewerId = randomUUID(),
    apiKey = `MOCK17_${randomUUID()}`;
  let context: Awaited<ReturnType<typeof createApp>>,
    issuer: Awaited<ReturnType<typeof createMockAuth>>,
    prisma: PrismaService,
    transactions: TransactionsService,
    tracking: ShipmentTrackingService,
    token: string,
    viewer: string;
  const providerCalls: Array<{
    endpoint: string;
    number: string;
    carrier?: number;
  }> = [];
  let mode:
    | 'ok'
    | 'unknown'
    | 'temporary'
    | 'already'
    | 'timeout-register'
    | 'empty'
    | 'additional' = 'ok';
  let paypalRows: Array<{
    observation: ShipmentObservation;
    original: Record<string, unknown>;
  }> = [];
  let erpRows: Array<{
    original: Record<string, unknown>;
    provider: string;
    containsDemo: boolean;
  }> = [];
  let realErp = false;
  beforeAll(async () => {
    issuer = await createMockAuth();
    const native = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://api-m.sandbox.paypal.com/')) {
        if (url.endsWith('/v1/oauth2/token'))
          return Response.json({
            access_token: 'MOCK_TOKEN',
            token_type: 'Bearer',
            expires_in: 300,
          });
        if (url.endsWith('/verify-webhook-signature'))
          return Response.json({ verification_status: 'SUCCESS' });
        throw new Error('UNEXPECTED_PAYPAL_MUTATION_OR_CALL');
      }
      if (url.startsWith('https://api.17track.net/')) {
        const endpoint = url.split('/').at(-1)!;
        const item = (
          JSON.parse(init!.body as string) as Array<{
            number: string;
            carrier?: number;
            destination_postal_code?: string;
          }>
        )[0]!;
        providerCalls.push({
          endpoint,
          number: item.number,
          carrier: item.carrier,
        });
        if (mode === 'temporary')
          return new Response('MOCK_PRIVATE_ERROR', { status: 503 });
        if (
          mode === 'additional' &&
          endpoint === 'register' &&
          !item.destination_postal_code
        )
          return Response.json(mock17Rejected(item.number, -18010019));
        if (mode === 'unknown')
          return Response.json(mock17Rejected(item.number, -18019903));
        if (mode === 'timeout-register' && endpoint === 'register')
          throw new Error('MOCK_NETWORK_TIMEOUT_AFTER_REGISTRATION');
        if (endpoint === 'register')
          return Response.json(
            mode === 'already'
              ? mock17Rejected(item.number, -18019901)
              : mock17Envelope({
                  number: item.number,
                  carrier: 100003,
                  origin: 1,
                }),
          );
        return Response.json(
          mock17Envelope(
            mode === 'empty'
              ? { number: item.number, carrier: 100003, track_info: null }
              : mock17Track(item.number),
          ),
        );
      }
      return native(input, init);
    });
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MERCHANT_ID: merchantId,
        SUPABASE_URL: issuer.origin,
        PAYPAL_CLIENT_ID: 'MOCK',
        PAYPAL_CLIENT_SECRET: 'MOCK',
        PAYPAL_WEBHOOK_ID: 'MOCK',
        SEVENTEENTRACK_API_KEY: apiKey,
        SEVENTEENTRACK_WEBHOOK_ENABLED: 'true',
        SHIPMENT_TRACKING_CACHE_SECONDS: 60,
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    transactions = context.app.get(TransactionsService);
    tracking = context.app.get(ShipmentTrackingService);
    vi.spyOn(context.app.get(PayPalTrackingSource), 'fetch').mockImplementation(
      async () => paypalRows,
    );
    const integrations = context.app.get(IntegrationsService);
    const actual = integrations.shipmentRecords.bind(integrations);
    vi.spyOn(integrations, 'shipmentRecords').mockImplementation(async (c) =>
      realErp
        ? actual(c)
        : { records: erpRows, errors: [], connected: erpRows.length > 0 },
    );
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'MOCK tracking merchant',
        members: {
          create: [
            { authUserId: userId, role: 'ADMIN' },
            { authUserId: viewerId, role: 'VIEWER' },
          ],
        },
      },
    });
    token = await issuer.token(userId);
    viewer = await issuer.token(viewerId);
  });
  beforeEach(() => {
    mode = 'ok';
    paypalRows = [];
    erpRows = [];
    realErp = false;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (prisma) {
      const where = { merchantId };
      await prisma.disputeEvent.deleteMany({ where: { dispute: where } });
      await prisma.dispute.deleteMany({ where });
      await prisma.evidenceItem.deleteMany({ where: { dossier: where } });
      await prisma.evidenceDossier.deleteMany({ where });
      await prisma.transaction.deleteMany({ where });
      await prisma.externalRecord.deleteMany({ where });
      await prisma.erpConnection.deleteMany({ where });
      await prisma.ingestionJob.deleteMany({ where: { event: where } });
      await prisma.webhookEvent.deleteMany({ where });
      await prisma.trackingRegistration.deleteMany({ where });
      await prisma.trackingUsage.deleteMany({ where });
      await prisma.trackingApiGate.deleteMany({
        where: {
          accountKey: createHash('sha256').update(apiKey).digest('hex'),
        },
      });
      await prisma.merchantMember.deleteMany({ where });
      await prisma.merchant.deleteMany({ where: { id: merchantId } });
    }
    await context?.app.close();
    await issuer?.close();
  });
  const http = () => request(context.app.getHttpServer());
  async function capture() {
    const id = `MOCK${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const event = captureEvent(id);
    event.resource.supplementary_data.related_ids.order_id = `ORDER${id}`;
    await http()
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(event)
      .expect(200);
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    return prisma.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: id },
    });
  }
  const guide = () => `MOCK${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  function observation(
    number: string,
    source: 'paypal' | 'erp' = 'paypal',
    time = new Date().toISOString(),
  ) {
    return {
      ...normalize17Track(mock17Track(number, 'InTransit', time)),
      source,
      sourceSystem: source === 'paypal' ? 'MOCK PayPal' : 'MOCK ERP',
    };
  }
  async function due(transactionId: string) {
    await prisma.shipmentTrackingJob.update({
      where: { transactionId },
      data: { nextAttemptAt: new Date(0) },
    });
  }
  async function retryRegistration(number: string) {
    await prisma.trackingRegistration.updateMany({
      where: { merchantId, trackingNumber: number },
      data: { nextAttemptAt: new Date(0) },
    });
  }
  it('uses fresh PayPal tracking without querying ERP or 17TRACK', async () => {
    const row = await capture(),
      number = guide();
    paypalRows = [
      { observation: observation(number), original: { explicitMock: true } },
    ];
    const before = providerCalls.length;
    const result = await tracking.resolveShipmentTracking(merchantId, row.id);
    expect(result).toMatchObject({
      state: 'CURRENT',
      selected: { source: 'paypal', trackingNumber: number },
    });
    expect(result.attempts.map((a) => a.source)).toEqual(['paypal']);
    expect(providerCalls.length).toBe(before);
  });
  it('uses a linked exact ERP shipment when PayPal has no tracking', async () => {
    const row = await capture(),
      number = guide();
    realErp = true;
    const connection = await prisma.erpConnection.create({
      data: { merchantId, provider: 'bind', status: 'connected' },
    });
    const payload = {
      paypalCaptureId: row.paypalCaptureId,
      trackingNumber: number,
      carrier: 'MOCK Carrier',
      status: 'IN_TRANSIT',
      events: [
        {
          occurredAt: new Date().toISOString(),
          status: 'IN_TRANSIT',
          description: 'MOCK ERP movement',
        },
      ],
    };
    await prisma.externalRecord.create({
      data: {
        merchantId,
        connectionId: connection.id,
        recordType: 'shipment',
        externalId: number,
        normalizedPayload: payload,
        sourceHash: contentHash(payload),
        updatedAt: new Date(),
      },
    });
    const before = providerCalls.length;
    const result = await tracking.resolveShipmentTracking(merchantId, row.id);
    expect(result).toMatchObject({
      state: 'CURRENT',
      selected: {
        source: 'erp',
        sourceSystem: 'erp:bind',
        trackingNumber: number,
      },
    });
    expect(providerCalls.length).toBe(before);
  });
  it('falls back to 17TRACK and stores delivery/events/raw data in the dossier without creating a POD', async () => {
    const row = await capture(),
      number = guide();
    const result = await http()
      .post(`/api/transactions/${row.id}/shipment-tracking/resolve`)
      .auth(token, { type: 'bearer' })
      .send({ trackingNumber: number })
      .expect(201);
    expect(result.body).toMatchObject({
      state: 'CURRENT',
      selected: {
        source: '17track',
        trackingNumber: number,
        status: 'DELIVERED',
        deliveryReported: true,
        documentaryProof: false,
      },
    });
    const snapshot = await prisma.shipmentTrackingSnapshot.findFirstOrThrow({
      where: { transactionId: row.id },
    });
    expect(snapshot.original).toMatchObject({ number, carrier: 100003 });
    const dossier = await transactions.dossier(merchantId, row.id);
    expect(
      dossier.items.some(
        (i) =>
          i.type === 'SHIPMENT_TRACKING_RECORD' &&
          i.sourceSystem === '17track:v2.4',
      ),
    ).toBe(true);
    expect(dossier.items.some((i) => i.type === 'PROOF_OF_DELIVERY')).toBe(
      false,
    );
    expect(
      (await transactions.detail(merchantId, row.id)).readiness.status,
    ).toBe('INCOMPLETE');
    expect(
      providerCalls.filter((c) => c.number === number).map((c) => c.endpoint),
    ).toEqual(['register', 'gettrackinfo']);
  });
  it('does not contact or register with 17TRACK when no guide exists', async () => {
    const row = await capture(),
      before = providerCalls.length;
    expect(
      await tracking.resolveShipmentTracking(merchantId, row.id),
    ).toMatchObject({ state: 'NO_TRACKING_NUMBER', selected: null });
    expect(providerCalls.length).toBe(before);
  });
  it('discovers a known guide from sparse ERP data and checks PayPal before 17TRACK', async () => {
    const row = await capture(),
      number = guide();
    erpRows = [
      {
        original: { trackingNumber: number, carrier: 'MOCK Carrier' },
        provider: 'bind',
        containsDemo: false,
      },
    ];
    const source = context.app.get(PayPalTrackingSource),
      before = vi.mocked(source.fetch).mock.calls.length;
    const result = await tracking.resolveShipmentTracking(merchantId, row.id);
    expect(result.selected?.source).toBe('17track');
    expect(
      vi
        .mocked(source.fetch)
        .mock.calls.slice(before)
        .map((c) => c[1]),
    ).toEqual([undefined, number]);
  });
  it('keeps invalid carrier detection errors permanent and accepts an explicit carrier override', async () => {
    const row = await capture(),
      number = guide();
    mode = 'unknown';
    const result = await tracking.resolveShipmentTracking(merchantId, row.id, {
      trackingNumber: number,
    });
    expect(result).toMatchObject({
      state: 'FAILED',
      errorCode: 'TRACK17_CARRIER_NOT_DETECTED',
      nextAttemptAt: null,
    });
    const before = providerCalls.length;
    await tracking.resolveShipmentTracking(merchantId, row.id);
    expect(providerCalls.length).toBe(before);
    mode = 'ok';
    expect(
      (
        await tracking.resolveShipmentTracking(merchantId, row.id, {
          carrierCode: 100003,
        })
      ).selected?.source,
    ).toBe('17track');
  });
  it('backs off temporary failures, caps five attempts and does not retry immediately', async () => {
    const row = await capture(),
      number = guide();
    mode = 'temporary';
    for (let i = 1; i <= 5; i++) {
      const result = await tracking.resolveShipmentTracking(
        merchantId,
        row.id,
        i === 1 ? { trackingNumber: number } : {},
      );
      expect(result.errorCode).toBe('TRACK17_HTTP_503');
      if (i < 5) {
        expect(result.nextAttemptAt).not.toBeNull();
        const before = providerCalls.length;
        await tracking.resolveShipmentTracking(merchantId, row.id);
        expect(providerCalls.length).toBe(before);
        await due(row.id);
        await retryRegistration(number);
      } else expect(result.nextAttemptAt).toBeNull();
    }
    expect(
      (
        await prisma.trackingRegistration.findFirstOrThrow({
          where: { merchantId, trackingNumber: number },
        })
      ).failures,
    ).toBe(5);
  });
  it('uses cache and registration leases across concurrent requests and shared guide contexts', async () => {
    const row = await capture(),
      number = guide();
    const results = await Promise.all([
      tracking.resolveShipmentTracking(merchantId, row.id, {
        trackingNumber: number,
      }),
      tracking.resolveShipmentTracking(merchantId, row.id, {
        trackingNumber: number,
      }),
    ]);
    expect(results.some((r) => r.selected?.source === '17track')).toBe(true);
    await tracking.resolveShipmentTracking(merchantId, row.id);
    const second = await capture();
    await tracking.resolveShipmentTracking(merchantId, second.id, {
      trackingNumber: number,
    });
    expect(
      providerCalls.filter((c) => c.number === number).map((c) => c.endpoint),
    ).toEqual(['register', 'gettrackinfo']);
    expect(
      await prisma.trackingRegistration.count({
        where: { merchantId, trackingNumber: number },
      }),
    ).toBe(1);
  });
  it('accepts already registered guides without registering repeatedly', async () => {
    const row = await capture(),
      number = guide();
    mode = 'already';
    expect(
      (
        await tracking.resolveShipmentTracking(merchantId, row.id, {
          trackingNumber: number,
        })
      ).selected?.source,
    ).toBe('17track');
    await due(row.id);
    await tracking.resolveShipmentTracking(merchantId, row.id);
    expect(
      providerCalls.filter(
        (c) => c.number === number && c.endpoint === 'register',
      ),
    ).toHaveLength(1);
  });
  it('queries first after an ambiguous registration timeout and avoids a second charged registration', async () => {
    const row = await capture(),
      number = guide();
    mode = 'timeout-register';
    await tracking.resolveShipmentTracking(merchantId, row.id, {
      trackingNumber: number,
    });
    await due(row.id);
    await retryRegistration(number);
    mode = 'ok';
    expect(
      (await tracking.resolveShipmentTracking(merchantId, row.id)).selected
        ?.source,
    ).toBe('17track');
    expect(
      providerCalls.filter((c) => c.number === number).map((c) => c.endpoint),
    ).toEqual(['register', 'gettrackinfo']);
  });
  it('keeps stale sources and flags a contradiction against an existing delivered report', async () => {
    const row = await capture(),
      number = guide();
    await tracking.resolveShipmentTracking(merchantId, row.id, {
      trackingNumber: number,
    });
    await due(row.id);
    paypalRows = [
      {
        observation: observation(
          number,
          'paypal',
          new Date(Date.now() + 1000).toISOString(),
        ),
        original: { explicitMock: true },
      },
    ];
    const result = await tracking.resolveShipmentTracking(merchantId, row.id);
    expect(result.state).toBe('NEEDS_REVIEW');
    expect(result.observations.map((o) => o.source).sort()).toEqual([
      '17track',
      'paypal',
    ]);
    expect(
      result.discrepancies.some((i) => i.startsWith('SOURCE_STATUS_CONFLICT')),
    ).toBe(true);
  });
  it('falls through stale PayPal and ERP data to 17TRACK', async () => {
    const row = await capture(),
      number = guide();
    paypalRows = [
      {
        observation: observation(number, 'paypal', '2026-01-01T00:00:00Z'),
        original: { explicitMock: true },
      },
    ];
    erpRows = [
      {
        original: {
          trackingNumber: number,
          status: 'IN_TRANSIT',
          events: [
            {
              occurredAt: '2026-01-01T00:00:00Z',
              status: 'IN_TRANSIT',
              description: 'MOCK stale event',
            },
          ],
        },
        provider: 'bind',
        containsDemo: false,
      },
    ];
    const result = await tracking.resolveShipmentTracking(merchantId, row.id);
    expect(result.selected?.source).toBe('17track');
    expect(result.attempts.filter((a) => a.state === 'STALE')).toHaveLength(2);
  });
  it('authenticates reads, limits writes to ADMIN and isolates merchant data', async () => {
    const row = await capture();
    await http()
      .get(`/api/transactions/${row.id}/shipment-tracking`)
      .expect(401);
    await http()
      .get(`/api/transactions/${row.id}/shipment-tracking`)
      .auth(viewer, { type: 'bearer' })
      .expect(200);
    await http()
      .post(`/api/transactions/${row.id}/shipment-tracking/resolve`)
      .auth(viewer, { type: 'bearer' })
      .send({})
      .expect(403);
    await http()
      .post(`/api/transactions/${row.id}/shipment-tracking/resolve`)
      .auth(token, { type: 'bearer' })
      .send({ trackingNumber: 'https://bad' })
      .expect(400);
    await expect(
      tracking.resolveShipmentTracking(randomUUID(), row.id, {
        trackingNumber: guide(),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('includes the tracking report in a linked dispute without any submission action', async () => {
    const row = await capture(),
      number = guide();
    const event = disputeEvent({
      sellerTransactionIds: [row.paypalCaptureId],
      disputeId: `MOCKDISPUTE${randomUUID()}`,
    });
    await http()
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(event)
      .expect(200);
    expect(
      await context.app.get(DisputesService).processNextDispute(merchantId),
    ).toBe('COMPLETED');
    const dispute = await prisma.dispute.findFirstOrThrow({
      where: { merchantId, transactionId: row.id },
    });
    const response = await http()
      .post(`/api/disputes/${dispute.id}/shipment-tracking/resolve`)
      .auth(token, { type: 'bearer' })
      .send({ trackingNumber: number })
      .expect(201);
    expect(response.body.disputeIds).toContain(dispute.id);
    expect(
      await prisma.submission.count({ where: { disputeId: dispute.id } }),
    ).toBe(0);
    await http()
      .get(`/api/disputes/${dispute.id}/shipment-tracking`)
      .auth(viewer, { type: 'bearer' })
      .expect(200);
  });
  it('verifies exact raw webhook bytes, deduplicates, rejects unknown guides and keeps newer data', async () => {
    const row = await capture(),
      number = guide();
    await tracking.resolveShipmentTracking(merchantId, row.id, {
      trackingNumber: number,
    });
    const sign = (body: string) =>
      createHash('sha256')
        .update(body + '/' + apiKey)
        .digest('hex');
    const before = await prisma.shipmentTrackingSnapshot.count({
      where: { transactionId: row.id },
    });
    const body = JSON.stringify({
      event: 'TRACKING_UPDATED',
      data: mock17Track(
        number,
        'Delivered',
        new Date(Date.now() + 1000).toISOString(),
      ),
    });
    await http()
      .post('/api/webhooks/17track')
      .set('Content-Type', 'application/json')
      .set('sign', sign(body))
      .send(body)
      .expect(200);
    await http()
      .post('/api/webhooks/17track')
      .set('Content-Type', 'application/json')
      .set('sign', sign(body))
      .send(body)
      .expect(200);
    expect(
      await prisma.shipmentTrackingSnapshot.count({
        where: { transactionId: row.id },
      }),
    ).toBe(before + 1);
    await http()
      .post('/api/webhooks/17track')
      .set('Content-Type', 'application/json')
      .set('sign', sign(body))
      .send(body + ' ')
      .expect(401);
    const old = JSON.stringify({
      event: 'TRACKING_UPDATED',
      data: mock17Track(number, 'InTransit', '2026-01-01T00:00:00Z'),
    });
    await http()
      .post('/api/webhooks/17track')
      .set('Content-Type', 'application/json')
      .set('sign', sign(old))
      .send(old)
      .expect(200);
    expect((await tracking.read(merchantId, row.id)).selected?.status).toBe(
      'DELIVERED',
    );
    const unknown = JSON.stringify({
      event: 'TRACKING_UPDATED',
      data: mock17Track(guide()),
    });
    const count = await prisma.shipmentTrackingSnapshot.count({
      where: { merchantId },
    });
    await http()
      .post('/api/webhooks/17track')
      .set('Content-Type', 'application/json')
      .set('sign', sign(unknown))
      .send(unknown)
      .expect(200);
    expect(
      await prisma.shipmentTrackingSnapshot.count({ where: { merchantId } }),
    ).toBe(count);
  });
  it('caps daily merchant consumption before external registration', async () => {
    const row = await capture(),
      number = guide();
    const usage = await context.app
      .get(TrackingRegistrationService)
      .usage(merchantId);
    expect(usage!.requests).toBeGreaterThan(0);
    expect(usage!.registrations).toBeGreaterThan(0);
    await prisma.trackingUsage.update({
      where: {
        merchantId_day: {
          merchantId,
          day: new Date().toISOString().slice(0, 10),
        },
      },
      data: { registrationAttempts: 100 },
    });
    const before = providerCalls.length;
    const result = await tracking.resolveShipmentTracking(merchantId, row.id, {
      trackingNumber: number,
    });
    expect(result.errorCode).toBe('TRACK17_MERCHANT_DAILY_LIMIT');
    expect(providerCalls.length).toBe(before);
    await prisma.trackingUsage.update({
      where: {
        merchantId_day: {
          merchantId,
          day: new Date().toISOString().slice(0, 10),
        },
      },
      data: { registrationAttempts: usage!.registrationAttempts },
    });
  });
  it('runs automatic transaction/dispute scheduling through the existing durable-job pattern', async () => {
    const row = await capture();
    await context.app.get(ShipmentTrackingWorker).processNext();
    expect(
      await prisma.shipmentTrackingJob.findUnique({
        where: { transactionId: row.id },
      }),
    ).not.toBeNull();
  });
  it('uses a carrier identifier supplied by the ERP before requesting auto detection', async () => {
    const row = await capture(),
      number = guide();
    erpRows = [
      {
        original: {
          trackingNumber: number,
          carrier: 'MOCK Carrier',
          carrierCode: 100003,
        },
        provider: 'bind',
        containsDemo: false,
      },
    ];
    const result = await tracking.resolveShipmentTracking(merchantId, row.id);
    expect(result.selected?.source).toBe('17track');
    expect(
      providerCalls.find(
        (c) => c.number === number && c.endpoint === 'register',
      )?.carrier,
    ).toBe(100003);
  });
  it('allows correcting carrier-required fields after a definite registration rejection', async () => {
    const row = await capture(),
      number = guide();
    mode = 'additional';
    expect(
      (
        await tracking.resolveShipmentTracking(merchantId, row.id, {
          trackingNumber: number,
        })
      ).errorCode,
    ).toBe('TRACK17_ADDITIONAL_FIELDS_REQUIRED');
    const result = await tracking.resolveShipmentTracking(merchantId, row.id, {
      destinationPostalCode: '12345',
    });
    expect(result.selected?.source).toBe('17track');
    expect(
      providerCalls.filter(
        (c) => c.number === number && c.endpoint === 'register',
      ),
    ).toHaveLength(2);
  });
  it('bounds the asynchronous no-data polling without registering the guide again', async () => {
    const row = await capture(),
      number = guide();
    mode = 'empty';
    for (let i = 1; i <= 5; i++) {
      const result = await tracking.resolveShipmentTracking(
        merchantId,
        row.id,
        i === 1 ? { trackingNumber: number } : {},
      );
      expect(result.errorCode).toBe('TRACK17_NO_DATA');
      if (i < 5) {
        await due(row.id);
        await prisma.trackingRegistration.updateMany({
          where: { merchantId, trackingNumber: number },
          data: { lastCheckedAt: new Date(0) },
        });
      } else expect(result.nextAttemptAt).toBeNull();
    }
    expect(
      providerCalls.filter(
        (c) => c.number === number && c.endpoint === 'register',
      ),
    ).toHaveLength(1);
  });
  it('shares registration leases across different transactions resolving the same guide concurrently', async () => {
    const a = await capture(),
      b = await capture(),
      number = guide();
    await Promise.all([
      tracking.resolveShipmentTracking(merchantId, a.id, {
        trackingNumber: number,
      }),
      tracking.resolveShipmentTracking(merchantId, b.id, {
        trackingNumber: number,
      }),
    ]);
    expect(
      providerCalls.filter(
        (c) => c.number === number && c.endpoint === 'register',
      ),
    ).toHaveLength(1);
    await due(b.id);
    expect(
      (await tracking.resolveShipmentTracking(merchantId, b.id)).selected
        ?.source,
    ).toBe('17track');
  });
  it('recovers an expired transaction lease without repeating registration', async () => {
    const row = await capture(),
      number = guide();
    await tracking.resolveShipmentTracking(merchantId, row.id, {
      trackingNumber: number,
    });
    await prisma.shipmentTrackingJob.update({
      where: { transactionId: row.id },
      data: {
        status: 'SYNCING',
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(0),
        nextAttemptAt: null,
      },
    });
    await tracking.resolveShipmentTracking(merchantId, row.id);
    expect(
      (
        await prisma.shipmentTrackingJob.findUniqueOrThrow({
          where: { transactionId: row.id },
        })
      ).leaseToken,
    ).toBeNull();
    expect(
      providerCalls.filter(
        (c) => c.number === number && c.endpoint === 'register',
      ),
    ).toHaveLength(1);
  });
  it('reports missing credentials honestly and recovers when a provider key is configured', async () => {
    const row = await capture(),
      number = guide();
    const unconfigured = await createApp(
      { NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL },
      false,
    );
    await unconfigured.app.init();
    try {
      const result = await unconfigured.app
        .get(ShipmentTrackingService)
        .resolveShipmentTracking(merchantId, row.id, {
          trackingNumber: number,
        });
      expect(result).toMatchObject({
        state: 'NOT_CONFIGURED',
        errorCode: 'TRACK17_NOT_CONFIGURED',
        selected: null,
      });
    } finally {
      await unconfigured.app.close();
    }
    expect(
      (await tracking.resolveShipmentTracking(merchantId, row.id)).selected
        ?.source,
    ).toBe('17track');
  });
  it('reuses an automatically detected registration when the same known carrier is supplied later', async () => {
    const row = await capture(),
      number = guide();
    await tracking.resolveShipmentTracking(merchantId, row.id, {
      trackingNumber: number,
    });
    await context.app
      .get(TrackingRegistrationService)
      .fetch(merchantId, number, { carrierCode: 100003 });
    expect(
      providerCalls.filter(
        (c) => c.number === number && c.endpoint === 'register',
      ),
    ).toHaveLength(1);
    expect(
      await prisma.trackingRegistration.count({
        where: { merchantId, trackingNumber: number },
      }),
    ).toBe(1);
  });
  it('permits a one-time ADMIN retry after recovery without storing an automatic retry override', async () => {
    const row = await capture(),
      number = guide();
    mode = 'unknown';
    await tracking.resolveShipmentTracking(merchantId, row.id, {
      trackingNumber: number,
    });
    mode = 'ok';
    const response = await http()
      .post(`/api/transactions/${row.id}/shipment-tracking/resolve`)
      .auth(token, { type: 'bearer' })
      .send({ retryFailed: true })
      .expect(201);
    expect(response.body.selected?.source).toBe('17track');
    expect(
      (
        await prisma.shipmentTrackingJob.findUniqueOrThrow({
          where: { transactionId: row.id },
        })
      ).input,
    ).not.toHaveProperty('retryFailed');
  });
  it('honors signed tracking-stopped notifications without a new paid registration', async () => {
    const row = await capture(),
      number = guide();
    await tracking.resolveShipmentTracking(merchantId, row.id, {
      trackingNumber: number,
    });
    const body = JSON.stringify({
      event: 'TRACKING_STOPPED',
      data: { number, carrier: 100003 },
    });
    const signature = createHash('sha256')
      .update(body + '/' + apiKey)
      .digest('hex');
    await http()
      .post('/api/webhooks/17track')
      .set('Content-Type', 'application/json')
      .set('sign', signature)
      .send(body)
      .expect(200);
    await prisma.trackingRegistration.updateMany({
      where: { merchantId, trackingNumber: number },
      data: { lastCheckedAt: new Date(0) },
    });
    const before = providerCalls.length;
    await expect(
      context.app
        .get(TrackingRegistrationService)
        .fetch(merchantId, number, {}),
    ).rejects.toMatchObject({ code: 'TRACK17_TRACKING_STOPPED' });
    expect(providerCalls.length).toBe(before);
  });
  it('shares a 429 Retry-After cooldown across every guide using the same API account', async () => {
    const { SeventeenTrackClient } =
      await import('../../src/modules/shipment-tracking/seventeentrack.client.js');
    const { TrackingProviderError } =
      await import('../../src/modules/shipment-tracking/tracking-normalization.js');
    const registrations = context.app.get(TrackingRegistrationService);
    const client = vi
      .spyOn(context.app.get(SeventeenTrackClient), 'request')
      .mockRejectedValueOnce(
        new TrackingProviderError('TRACK17_HTTP_429', true, 429, 120000),
      );
    try {
      await expect(
        registrations.fetch(merchantId, guide(), {}),
      ).rejects.toMatchObject({ code: 'TRACK17_HTTP_429' });
      await expect(
        registrations.fetch(merchantId, guide(), {}),
      ).rejects.toMatchObject({ code: 'TRACK17_RATE_LIMIT' });
      expect(client).toHaveBeenCalledTimes(1);
    } finally {
      client.mockRestore();
      await prisma.trackingApiGate.update({
        where: { accountKey: registrations.accountKey() },
        data: { nextRequestAt: new Date(0) },
      });
    }
  });
  it('enables RLS on all private tracking tables', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean }>
    >`SELECT relrowsecurity FROM pg_class WHERE relname IN ('shipment_tracking_jobs','shipment_tracking_snapshots','tracking_registrations','tracking_usage','tracking_api_gates')`;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
