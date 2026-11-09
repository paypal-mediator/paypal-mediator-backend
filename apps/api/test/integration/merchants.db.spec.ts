import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  IntegrationsResponseSchema,
  MerchantResponseSchema,
} from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { MerchantsService } from '../../src/modules/merchants/merchants.service.js';
import { AuditService } from '../../src/modules/monitoring/audit.service.js';
import { PayPalConnectionClient } from '../../src/modules/merchants/paypal/paypal-connection.client.js';
import { createMockAuth } from '../fixtures/auth.js';

describe('M01 HTTP + PostgreSQL + signed JWTs (MOCK identity issuer and PayPal)', () => {
  const merchantId = randomUUID();
  const otherMerchantId = randomUUID();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  const outsiderId = randomUUID();
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let context: Awaited<ReturnType<typeof createApp>>;
  let prisma: PrismaService;
  let adminToken: string;
  let viewerToken: string;
  let paypal: PayPalConnectionClient;
  let service: MerchantsService;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('TEST_DATABASE_URL is required');
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        SUPABASE_URL: issuer.origin,
        MERCHANT_ID: merchantId,
        PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
        PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    paypal = context.app.get(PayPalConnectionClient);
    service = context.app.get(MerchantsService);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'MOCK Merchant',
        members: {
          create: [
            { authUserId: adminId, role: 'ADMIN' },
            { authUserId: viewerId, role: 'VIEWER' },
          ],
        },
      },
    });
    await prisma.merchant.create({
      data: {
        id: otherMerchantId,
        displayName: 'MOCK Other Merchant',
        members: { create: { authUserId: outsiderId, role: 'ADMIN' } },
      },
    });
    adminToken = await issuer.token(adminId);
    viewerToken = await issuer.token(viewerId);
    vi.spyOn(paypal, 'check').mockResolvedValue({
      connectionStatus: 'CONNECTED',
      disputesReadStatus: 'AVAILABLE',
      paypalHttpStatus: 200,
      paypalDebugId: 'MOCK-DEBUG',
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (prisma) {
      const where = { merchantId: { in: [merchantId, otherMerchantId] } };
      await prisma.merchantEvent.deleteMany({ where });
      await prisma.merchantIntegration.deleteMany({ where });
      await prisma.merchantMember.deleteMany({ where });
      await prisma.merchant.deleteMany({
        where: { id: { in: [merchantId, otherMerchantId] } },
      });
    }
    await context?.app.close();
    await issuer?.close();
  });

  it('requires login and never invokes PayPal on rejected requests', async () => {
    await request(context.app.getHttpServer())
      .get('/api/merchants/me')
      .expect(401);
    await request(context.app.getHttpServer())
      .post('/api/settings/integrations/paypal/check')
      .expect(401);
    expect(paypal.check).not.toHaveBeenCalled();
  });

  it('denies a valid user with no membership or another merchant membership', async () => {
    for (const userId of [randomUUID(), outsiderId]) {
      await request(context.app.getHttpServer())
        .get('/api/merchants/me')
        .auth(await issuer.token(userId), { type: 'bearer' })
        .expect(403);
    }
  });

  it('returns only the authorized merchant and conservative default policy', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/merchants/me')
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    expect(MerchantResponseSchema.parse(response.body)).toMatchObject({
      id: merchantId,
      role: 'VIEWER',
      policy: {
        allowInvestigations: false,
        allowSubmissions: false,
        requireMerchantApproval: true,
      },
    });
    await expect(
      service.assertActionAllowed(merchantId, 'SUBMIT'),
    ).rejects.toMatchObject({ code: 'MERCHANT_ACTION_DISABLED' });
    await expect(
      service.assertActionAllowed(otherMerchantId, 'INVESTIGATE'),
    ).rejects.toMatchObject({ code: 'MERCHANT_ACCESS_DENIED' });
  });

  it('blocks viewer writes and PayPal checks', async () => {
    await request(context.app.getHttpServer())
      .patch('/api/merchants/me/settings')
      .auth(viewerToken, { type: 'bearer' })
      .send({ allowSubmissions: true })
      .expect(403);
    await request(context.app.getHttpServer())
      .post('/api/settings/integrations/paypal/check')
      .auth(viewerToken, { type: 'bearer' })
      .expect(403);
    expect(paypal.check).not.toHaveBeenCalled();
  });

  it('never reports connected before checking and does not expose configured secrets', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/settings/integrations')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(
      IntegrationsResponseSchema.parse(response.body).paypal,
    ).toMatchObject({
      connectionStatus: 'NOT_CHECKED',
      lastCheckedAt: null,
      credentialsConfigured: true,
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /MOCK_SECRET|MOCK_CLIENT|credentialFingerprint/,
    );
    expect(paypal.check).not.toHaveBeenCalled();
  });

  it('updates policy atomically with an actor event', async () => {
    const response = await request(context.app.getHttpServer())
      .patch('/api/merchants/me/settings')
      .auth(adminToken, { type: 'bearer' })
      .send({ allowInvestigations: true, displayName: 'Updated Merchant' })
      .expect(200);
    expect(response.body.policy.allowInvestigations).toBe(true);
    const auditRows = await prisma.auditEvent.findMany({
      where: { merchantId },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorUserId: adminId,
      record: {
        action: 'SETTINGS_UPDATED',
        details: { displayNameChanged: true, allowInvestigations: true },
      },
    });
    expect(JSON.stringify(auditRows)).not.toContain('Updated Merchant');
    expect(
      await prisma.merchantEvent.count({
        where: { merchantId, actorUserId: adminId, action: 'SETTINGS_UPDATED' },
      }),
    ).toBe(1);
    await expect(
      service.assertActionAllowed(merchantId, 'INVESTIGATE'),
    ).resolves.toBeUndefined();
  });

  it('rolls back settings when M09 audit persistence fails', async () => {
    const before = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
    });
    const audit = context.app.get(AuditService);
    const failure = vi
      .spyOn(audit, 'append')
      .mockRejectedValueOnce(new Error('MOCK audit unavailable'));
    try {
      await request(context.app.getHttpServer())
        .patch('/api/merchants/me/settings')
        .auth(adminToken, { type: 'bearer' })
        .send({ displayName: 'MUST ROLLBACK' })
        .expect(500);
      const after = await prisma.merchant.findUniqueOrThrow({
        where: { id: merchantId },
      });
      expect(after.displayName).toBe(before.displayName);
      expect(
        await prisma.auditEvent.count({
          where: { merchantId, action: 'SETTINGS_UPDATED' },
        }),
      ).toBe(1);
    } finally {
      failure.mockRestore();
    }
  });

  it.each([
    { requireMerchantApproval: false },
    { role: 'ADMIN' },
    { merchantId: randomUUID() },
    {},
    { allowSubmissions: 'true' },
  ])('rejects unsafe settings %j', async (body) => {
    await request(context.app.getHttpServer())
      .patch('/api/merchants/me/settings')
      .auth(adminToken, { type: 'bearer' })
      .send(body)
      .expect(400);
    const stored = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
    });
    expect(stored.requireMerchantApproval).toBe(true);
    expect(stored.allowSubmissions).toBe(false);
  });

  it('persists the MOCK check result and actor without tokens or credentials', async () => {
    const response = await request(context.app.getHttpServer())
      .post('/api/settings/integrations/paypal/check')
      .auth(adminToken, { type: 'bearer' })
      .expect(201);
    expect(
      IntegrationsResponseSchema.parse(response.body).paypal,
    ).toMatchObject({
      connectionStatus: 'CONNECTED',
      disputesReadStatus: 'AVAILABLE',
      paypalDebugId: 'MOCK-DEBUG',
    });
    const stored = await prisma.merchantIntegration.findUniqueOrThrow({
      where: { merchantId },
    });
    expect(stored.lastCheckedAt).toBeInstanceOf(Date);
    expect(
      await prisma.merchantEvent.count({
        where: {
          merchantId,
          actorUserId: adminId,
          action: 'PAYPAL_CONNECTION_CHECKED',
        },
      }),
    ).toBe(1);
    expect(JSON.stringify(stored)).not.toMatch(
      /MOCK_SECRET|MOCK_CLIENT|MOCK_ACCESS_TOKEN/,
    );
  });

  it('does not reuse connection results after credential rotation', async () => {
    const rotatedEnvironment = {
      ...context.environment,
      PAYPAL_CLIENT_SECRET: 'MOCK_ROTATED',
    };
    const rotated = new MerchantsService(
      prisma,
      rotatedEnvironment,
      new PayPalConnectionClient(rotatedEnvironment, fetch),
      context.app.get(AuditService),
    );
    expect((await rotated.getIntegrations(merchantId)).paypal).toMatchObject({
      connectionStatus: 'NOT_CHECKED',
      disputesReadStatus: 'NOT_CHECKED',
      lastCheckedAt: null,
    });
  });

  it('blocks direct table reads from a non-owner role despite general SELECT privileges', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE pg_read_all_data`;
      const counts = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM merchant_members`;
      expect(counts[0]?.count).toBe(0n);
      const merchants = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM merchants`;
      expect(merchants[0]?.count).toBe(0n);
    });
  });

  it('enforces mandatory approval even for direct database writes', async () => {
    await expect(
      prisma.$executeRaw`UPDATE merchants SET require_merchant_approval = false WHERE id = ${merchantId}::uuid`,
    ).rejects.toThrow();
    expect(
      (await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } }))
        .requireMerchantApproval,
    ).toBe(true);
  });

  it('uses current membership on every request and blocks a deactivated member', async () => {
    const member = await prisma.merchantMember.findFirst({
      where: { authUserId: viewerId, merchantId },
    });
    await prisma.merchantMember.update({
      where: { id: member!.id },
      data: { active: false },
    });
    await request(context.app.getHttpServer())
      .get('/api/merchants/me')
      .auth(viewerToken, { type: 'bearer' })
      .expect(403);
  });
});
