import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WebhookReceiptSchema } from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { createMockAuth } from '../fixtures/auth.js';
import {
  mockTransmissionHeaders,
  mockWebhookEvent,
} from '../fixtures/paypal-webhook.js';

describe('M01 ↔ M02 communication over HTTP and real PostgreSQL (MOCK PayPal/JWKS)', () => {
  const merchantId = randomUUID();
  const userId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>;
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let prisma: PrismaService;
  let userToken: string;
  let mode: 'SUCCESS' | 'FAILURE' | 'UNAVAILABLE' | 'AUTH_FAILURE' = 'SUCCESS';
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('TEST_DATABASE_URL is required');
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.startsWith('https://api-m.sandbox.paypal.com/'))
        return nativeFetch(input, init);
      calls.push({ path: new URL(url).pathname, init });
      if (url.endsWith('/v1/oauth2/token')) {
        return new Response(
          JSON.stringify(
            mode === 'AUTH_FAILURE'
              ? { error: 'MOCK_INVALID_CLIENT' }
              : {
                  access_token: 'MOCK_M01_SERVER_TOKEN',
                  token_type: 'Bearer',
                  expires_in: 300,
                },
          ),
          { status: mode === 'AUTH_FAILURE' ? 401 : 200 },
        );
      }
      if (url.endsWith('/v1/notifications/verify-webhook-signature')) {
        return new Response(
          JSON.stringify(
            mode === 'UNAVAILABLE'
              ? { error: 'MOCK_UNAVAILABLE' }
              : { verification_status: mode },
          ),
          { status: mode === 'UNAVAILABLE' ? 503 : 200 },
        );
      }
      throw new Error('Unexpected MOCK PayPal request');
    });
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MERCHANT_ID: merchantId,
        SUPABASE_URL: issuer.origin,
        PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
        PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
        PAYPAL_WEBHOOK_ID: 'MOCK-CONFIGURED-WEBHOOK',
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'DEMO / MOCK M01-M02',
        members: { create: { authUserId: userId, role: 'ADMIN' } },
      },
    });
    userToken = await issuer.token(userId);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (prisma) {
      await prisma.ingestionJob.deleteMany({
        where: { event: { merchantId } },
      });
      await prisma.webhookEvent.deleteMany({ where: { merchantId } });
      await prisma.merchantMember.deleteMany({ where: { merchantId } });
      await prisma.merchant.deleteMany({ where: { id: merchantId } });
    }
    await context?.app.close();
    await issuer?.close();
  });

  const deliver = (event: object) =>
    request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(event);
  const eventCount = (paypalEventId: string) =>
    prisma.webhookEvent.count({ where: { merchantId, paypalEventId } });

  it('uses M01 merchant context/OAuth and atomically persists the original event and one queued job', async () => {
    const event = {
      ...mockWebhookEvent(),
      merchant_id: 'MOCK_ATTACKER_CHOSEN_ID',
      extra: { preserved: true },
    };
    const response = await deliver(event).expect(200);
    const receipt = WebhookReceiptSchema.parse(response.body);
    expect(receipt.outcome).toBe('ACCEPTED');
    expect(receipt.jobId).not.toBeNull();
    const stored = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: receipt.eventId },
      include: { job: true },
    });
    expect(stored.merchantId).toBe(merchantId);
    expect(stored.webhookId).toBe('MOCK-CONFIGURED-WEBHOOK');
    expect(stored.payload).toEqual(event);
    expect(JSON.parse(stored.rawBody)).toEqual(event);
    expect(stored.rawBodyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.job).toMatchObject({
      kind: 'TRANSACTION_CAPTURED',
      status: 'QUEUED',
    });
    expect(
      await prisma.auditEvent.findFirst({
        where: {
          merchantId,
          resourceId: stored.id,
          action: 'WEBHOOK_RECEIVED',
        },
      }),
    ).toMatchObject({
      module: 'M02',
      actorKind: 'PAYPAL',
      outcome: 'SUCCEEDED',
    });
    const verification = calls.find((call) =>
      call.path.endsWith('verify-webhook-signature'),
    );
    expect(verification?.init?.headers).toMatchObject({
      Authorization: 'Bearer MOCK_M01_SERVER_TOKEN',
    });
    expect(JSON.parse(String(verification?.init?.body))).toMatchObject({
      webhook_id: 'MOCK-CONFIGURED-WEBHOOK',
      webhook_event: event,
    });
    expect(calls.some((call) => call.path === '/v1/oauth2/token')).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(
      /MOCK_SECRET|MOCK_M01_SERVER_TOKEN|MOCK_ATTACKER/,
    );
  });

  it('still protects M01 settings with user JWTs and keeps policies unchanged by ingestion', async () => {
    await request(context.app.getHttpServer())
      .get('/api/settings/integrations')
      .expect(401);
    const integration = await request(context.app.getHttpServer())
      .get('/api/settings/integrations')
      .auth(userToken, { type: 'bearer' })
      .expect(200);
    expect(integration.body.paypal.webhookConfigured).toBe(true);
    expect(integration.body.paypal.connectionStatus).toBe('NOT_CHECKED');
    const merchant = await request(context.app.getHttpServer())
      .get('/api/merchants/me')
      .auth(userToken, { type: 'bearer' })
      .expect(200);
    expect(merchant.body.policy).toEqual({
      allowInvestigations: false,
      allowSubmissions: false,
      requireMerchantApproval: true,
    });
    expect(
      await prisma.merchantIntegration.count({ where: { merchantId } }),
    ).toBe(0);
  });

  it('deduplicates simultaneous deliveries using a database uniqueness constraint', async () => {
    const event = mockWebhookEvent();
    const responses = await Promise.all([deliver(event), deliver(event)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.body.outcome).sort()).toEqual([
      'ACCEPTED',
      'DUPLICATE',
    ]);
    expect(responses[0]?.body.jobId).toBe(responses[1]?.body.jobId);
    expect(await eventCount(event.id)).toBe(1);
    expect(
      await prisma.ingestionJob.count({
        where: { event: { merchantId, paypalEventId: event.id } },
      }),
    ).toBe(1);
  });

  it('tolerates reordered JSON and whitespace without overwriting original bytes', async () => {
    const event = mockWebhookEvent();
    const first = await deliver(event).expect(200);
    const original = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: first.body.eventId },
    });
    const reordered = JSON.stringify(
      {
        summary: event.summary,
        resource: event.resource,
        event_type: event.event_type,
        event_version: event.event_version,
        id: event.id,
        create_time: event.create_time,
      },
      null,
      2,
    );
    const duplicate = await request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .type('json')
      .send(reordered)
      .expect(200);
    expect(duplicate.body.outcome).toBe('DUPLICATE');
    expect(
      (
        await prisma.webhookEvent.findUniqueOrThrow({
          where: { id: original.id },
        })
      ).rawBodyHash,
    ).toBe(original.rawBodyHash);
  });

  it('blocks changed contents under a previously verified event ID', async () => {
    const event = mockWebhookEvent();
    await deliver(event).expect(200);
    const conflict = await deliver({
      ...event,
      resource: { id: 'MOCK_DIFFERENT_CAPTURE' },
    }).expect(409);
    expect(conflict.body.code).toBe('WEBHOOK_EVENT_CONFLICT');
    expect(await eventCount(event.id)).toBe(1);
  });

  it.each([
    'CUSTOMER.DISPUTE.CREATED',
    'CUSTOMER.DISPUTE.UPDATED',
    'CUSTOMER.DISPUTE.RESOLVED',
  ])('queues %s for future M07 consumption', async (eventType) => {
    const response = await deliver(mockWebhookEvent(eventType)).expect(200);
    expect(
      await prisma.ingestionJob.findUniqueOrThrow({
        where: { id: response.body.jobId },
      }),
    ).toMatchObject({ kind: 'DISPUTE_CHANGED', status: 'QUEUED' });
  });

  it('persists verified unsupported events without pretending they were processed', async () => {
    const event = mockWebhookEvent('PAYMENT.CAPTURE.PENDING');
    const response = await deliver(event).expect(200);
    expect(response.body).toMatchObject({ outcome: 'IGNORED', jobId: null });
    expect(await eventCount(event.id)).toBe(1);
  });

  it.each([
    ['FAILURE', 401, 'INVALID_WEBHOOK_SIGNATURE'],
    ['UNAVAILABLE', 503, 'WEBHOOK_VERIFICATION_UNAVAILABLE'],
    ['AUTH_FAILURE', 503, 'WEBHOOK_VERIFICATION_UNAVAILABLE'],
  ] as const)(
    'does not persist or enqueue when PayPal returns %s',
    async (scenario, status, code) => {
      mode = scenario;
      const event = mockWebhookEvent();
      try {
        const response = await deliver(event).expect(status);
        expect(response.body.code).toBe(code);
        expect(await eventCount(event.id)).toBe(0);
      } finally {
        mode = 'SUCCESS';
      }
    },
  );

  it('verifies duplicates again instead of acknowledging an unauthenticated replay', async () => {
    const event = mockWebhookEvent();
    await deliver(event).expect(200);
    mode = 'FAILURE';
    try {
      await deliver(event).expect(401);
    } finally {
      mode = 'SUCCESS';
    }
    expect(await eventCount(event.id)).toBe(1);
  });

  it('rolls back the event if queue persistence fails, allowing a safe redelivery', async () => {
    const event = mockWebhookEvent();
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION m02_test_fail_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'MOCK_QUEUE_FAILURE'; END $$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER m02_test_queue_failure BEFORE INSERT ON ingestion_jobs FOR EACH ROW EXECUTE FUNCTION m02_test_fail_job_insert()',
    );
    try {
      await deliver(event).expect(500);
      expect(await eventCount(event.id)).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER m02_test_queue_failure ON ingestion_jobs',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION m02_test_fail_job_insert()',
      );
    }
    expect((await deliver(event).expect(200)).body.outcome).toBe('ACCEPTED');
  });

  it('keeps webhook payloads and queued jobs inaccessible to non-owner database roles', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE pg_read_all_data`;
      const events = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM webhook_events`;
      const jobs = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM ingestion_jobs`;
      expect(events[0]?.count).toBe(0n);
      expect(jobs[0]?.count).toBe(0n);
    });
  });
});
