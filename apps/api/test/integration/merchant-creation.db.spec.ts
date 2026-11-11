import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { createMockAuth } from '../fixtures/auth.js';

describe('Team creation (real PostgreSQL, signed MOCK identity)', () => {
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let context: Awaited<ReturnType<typeof createApp>>;
  let prisma: PrismaService;
  let token: string;
  const userId = randomUUID();
  const legacyMerchantId = randomUUID();
  const createdIds: string[] = [];

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('TEST_DATABASE_URL is required');
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        SUPABASE_URL: issuer.origin,
        MERCHANT_ID: legacyMerchantId,
        PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
        PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
        PAYPAL_WEBHOOK_ID: 'MOCK_WEBHOOK',
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    token = await issuer.token(userId);
  });
  afterAll(async () => {
    if (prisma) {
      const where = { merchantId: { in: createdIds } };
      await prisma.merchantEvent.deleteMany({ where });
      await prisma.merchantMember.deleteMany({ where });
      await prisma.merchant.deleteMany({ where: { id: { in: createdIds } } });
    }
    await context?.app.close();
    await issuer?.close();
  });

  it('requires a user token before creating a team', async () => {
    await request(context.app.getHttpServer())
      .post('/api/merchants')
      .send({ displayName: 'Unauthorized' })
      .expect(401);
    expect(
      await prisma.merchantMember.count({ where: { authUserId: userId } }),
    ).toBe(0);
  });

  it.each([
    {},
    { displayName: ' ' },
    { displayName: 'x'.repeat(121) },
    { displayName: 'MOCK', role: 'ADMIN' },
    { displayName: 'MOCK', authUserId: randomUUID() },
    { displayName: 'MOCK', merchantId: legacyMerchantId },
  ])(
    'rejects invalid or identity-overriding creation payload %j',
    async (body) => {
      await request(context.app.getHttpServer())
        .post('/api/merchants')
        .auth(token, { type: 'bearer' })
        .send(body)
        .expect(400);
    },
  );

  it('creates the owner membership, opens the selected empty workspace and isolates PayPal and other users', async () => {
    const created = await request(context.app.getHttpServer())
      .post('/api/merchants')
      .auth(token, { type: 'bearer' })
      .send({ displayName: '  MOCK New Team  ' })
      .expect(201);
    const id = created.body.id as string;
    createdIds.push(id);
    expect(created.body).toMatchObject({
      displayName: 'MOCK New Team',
      role: 'ADMIN',
      policy: {
        allowInvestigations: false,
        allowSubmissions: false,
        requireMerchantApproval: true,
      },
    });
    expect(
      await prisma.merchantMember.findFirst({ where: { merchantId: id } }),
    ).toMatchObject({ authUserId: userId, active: true, role: 'ADMIN' });
    expect(
      await prisma.merchantEvent.count({
        where: { merchantId: id, actorUserId: userId, action: 'TEAM_CREATED' },
      }),
    ).toBe(1);
    const teams = await request(context.app.getHttpServer())
      .get('/api/merchants')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(teams.body.items.map((team: { id: string }) => team.id)).toContain(
      id,
    );
    const selected = await request(context.app.getHttpServer())
      .get('/api/merchants/me')
      .auth(token, { type: 'bearer' })
      .set('X-Merchant-Id', id)
      .expect(200);
    expect(selected.body.id).toBe(id);
    const transactions = await request(context.app.getHttpServer())
      .get('/api/transactions')
      .auth(token, { type: 'bearer' })
      .set('X-Merchant-Id', id)
      .expect(200);
    expect(transactions.body.items).toEqual([]);
    const integrations = await request(context.app.getHttpServer())
      .get('/api/settings/integrations')
      .auth(token, { type: 'bearer' })
      .set('X-Merchant-Id', id)
      .expect(200);
    expect(integrations.body.paypal).toMatchObject({
      credentialsConfigured: false,
      webhookConfigured: false,
      connectionStatus: 'NOT_CONFIGURED',
    });
    await request(context.app.getHttpServer())
      .post('/api/settings/integrations/paypal/check')
      .auth(token, { type: 'bearer' })
      .set('X-Merchant-Id', id)
      .expect(409);
    await request(context.app.getHttpServer())
      .get('/api/merchants/me')
      .auth(await issuer.token(randomUUID()), { type: 'bearer' })
      .set('X-Merchant-Id', id)
      .expect(403);
    await request(context.app.getHttpServer())
      .get('/api/merchants/me')
      .auth(token, { type: 'bearer' })
      .set('X-Merchant-Id', legacyMerchantId)
      .expect(403);
    await request(context.app.getHttpServer())
      .get('/api/merchants/me')
      .auth(token, { type: 'bearer' })
      .set('X-Merchant-Id', 'invalid')
      .expect(400);
  });
});
