import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { TransactionsService } from '../../src/modules/transactions/index.js';
import { contentHash } from '../../src/common/data/content-hash.js';
import { createMockAuth } from '../fixtures/auth.js';
import { demoOrder, demoTracking } from '../fixtures/commerce.js';
import { captureEvent } from '../fixtures/capture.js';

describe('MEMBER operational editing without administration (real PostgreSQL/HTTP, MOCK identity and commerce)', () => {
  const merchantId = randomUUID(),
    adminId = randomUUID(),
    memberId = randomUUID(),
    viewerId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>,
    issuer: Awaited<ReturnType<typeof createMockAuth>>,
    db: PrismaService;
  let admin: string,
    member: string,
    viewer: string,
    orderId: string,
    transactionId: string;
  beforeAll(async () => {
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        SUPABASE_URL: issuer.origin,
        SUPABASE_SECRET_KEY: `sb_secret_${'m'.repeat(32)}`,
        INVITATION_EMAIL_WORKER_ENABLED: 'false',
      },
      false,
    );
    await context.app.init();
    db = context.app.get(PrismaService);
    await db.merchant.create({
      data: {
        id: merchantId,
        displayName: 'MOCK Member permissions',
        members: {
          create: [
            { authUserId: adminId, role: 'ADMIN' },
            { authUserId: viewerId, role: 'VIEWER' },
          ],
        },
      },
    });
    for (const [id, email] of [
      [adminId, 'admin-member@example.test'],
      [memberId, 'member@example.test'],
      [viewerId, 'viewer-member@example.test'],
    ])
      issuer.profiles.set(id!, {
        email: email!,
        email_confirmed_at: new Date().toISOString(),
      });
    admin = await issuer.token(adminId);
    member = await issuer.token(memberId);
    viewer = await issuer.token(viewerId);
  });
  afterAll(async () => {
    await context?.app.close();
    await issuer?.close();
  });
  const http = () => request(context.app.getHttpServer());
  const post = (path: string, body: object, token = member) =>
    http()
      .post('/api' + path)
      .auth(token, { type: 'bearer' })
      .set('X-Merchant-Id', merchantId)
      .send(body);
  it('invites and accepts MEMBER with confirmed identity, preserving that exact role', async () => {
    const invitation = await post(
      '/merchants/me/invitations',
      { email: 'member@example.test', role: 'MEMBER' },
      admin,
    ).expect(201);
    expect(invitation.body.role).toBe('MEMBER');
    const accepted = await post(
      `/merchant-invitations/${invitation.body.id}/accept`,
      {},
    ).expect(201);
    expect(accepted.body.role).toBe('MEMBER');
    expect(
      (
        await http()
          .get('/api/merchants/me')
          .auth(member, { type: 'bearer' })
          .set('X-Merchant-Id', merchantId)
          .expect(200)
      ).body.role,
    ).toBe('MEMBER');
  });
  it('lets MEMBER register an order and sourced evidence while VIEWER stays read-only', async () => {
    const order = await post('/orders', demoOrder('MEMBER')).expect(201);
    orderId = order.body.order.id;
    await post('/orders', demoOrder('VIEWER-BLOCKED'), viewer).expect(403);
    const event = captureEvent('CAP-MEMBER');
    event.resource.custom_id = 'ORDER-MEMBER';
    event.resource.supplementary_data.related_ids.order_id = 'PP-MEMBER';
    await db.webhookEvent.create({
      data: {
        merchantId,
        paypalEventId: event.id,
        eventType: event.event_type,
        eventCreatedAt: new Date(event.create_time),
        webhookId: 'MOCK',
        transmissionId: randomUUID(),
        payload: event,
        rawBody: JSON.stringify(event),
        payloadHash: contentHash(event),
        rawBodyHash: contentHash(event),
        job: { create: { kind: 'TRANSACTION_CAPTURED' } },
      },
    });
    expect(
      await context.app.get(TransactionsService).processNextCapture(merchantId),
    ).toBe('COMPLETED');
    const transaction = await db.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: 'CAP-MEMBER' },
    });
    transactionId = transaction.id;
    const evidence = await post(
      `/transactions/${transactionId}/evidence`,
      demoTracking('MEMBER'),
    ).expect(201);
    expect(evidence.body.outcome).toBe('CREATED');
    await post(
      `/transactions/${transactionId}/evidence`,
      demoTracking('MEMBER'),
      viewer,
    ).expect(403);
    await post(`/transactions/${transactionId}/refresh-evidence`, {}).expect(
      201,
    );
    await http()
      .get(`/api/transactions/${transactionId}/evidence`)
      .auth(member, { type: 'bearer' })
      .set('X-Merchant-Id', merchantId)
      .expect(200);
  });
  it('lets MEMBER manage operational buyer conversations while policy remains ADMIN-only', async () => {
    const link = await post('/conciliations/links', {
      orderId,
      expiresInDays: 1,
    }).expect(201);
    await post(`/conciliations/${link.body.id}/close`, {}).expect(201);
    await http()
      .put('/api/conciliations/policy')
      .auth(member, { type: 'bearer' })
      .set('X-Merchant-Id', merchantId)
      .send({ enabled: false, minScore: 0.9, rules: [] })
      .expect(403);
  });
  it('rejects MEMBER administration, invitations, ingestion retries and PayPal authorization', async () => {
    await http()
      .get('/api/merchants/me/invitations')
      .auth(member, { type: 'bearer' })
      .set('X-Merchant-Id', merchantId)
      .expect(403);
    await http()
      .patch('/api/merchants/me/settings')
      .auth(member, { type: 'bearer' })
      .set('X-Merchant-Id', merchantId)
      .send({ displayName: 'Cannot rename' })
      .expect(403);
    for (const path of [
      '/merchants/me/invitations',
      '/settings/integrations/paypal/connect',
      '/settings/integrations/paypal/check',
      `/event-ingestion/jobs/${randomUUID()}/retry`,
      `/disputes/${randomUUID()}/submit`,
      `/disputes/${randomUUID()}/investigate`,
    ])
      await post(path, {}).expect(403);
    await http()
      .get('/api/merchants/me')
      .auth(member, { type: 'bearer' })
      .set('X-Merchant-Id', randomUUID())
      .expect(403);
    expect(
      await db.merchant.findUnique({
        where: { id: merchantId },
        select: { displayName: true },
      }),
    ).toEqual({ displayName: 'MOCK Member permissions' });
  });
});
