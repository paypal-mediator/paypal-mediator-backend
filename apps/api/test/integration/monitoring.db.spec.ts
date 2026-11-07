import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ActivityResponseSchema,
  MonitoringMetricsResponseSchema,
} from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { AuditService } from '../../src/modules/monitoring/audit.service.js';
import { createMockAuth } from '../fixtures/auth.js';

describe('M09 PostgreSQL and HTTP (MOCK identity issuer)', () => {
  const merchantId = randomUUID();
  const userId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>;
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let prisma: PrismaService;
  let audit: AuditService;
  let token: string;
  const record = {
    action: 'SETTINGS_UPDATED' as const,
    details: { displayNameChanged: false },
  };

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
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    audit = context.app.get(AuditService);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'MOCK M09',
        members: { create: { authUserId: userId, role: 'VIEWER' } },
      },
    });
    token = await issuer.token(userId);
  });
  afterAll(async () => {
    await prisma?.merchantMember.deleteMany({ where: { merchantId } });
    await prisma?.merchant.deleteMany({ where: { id: merchantId } });
    await context?.app.close();
    await issuer?.close();
  });

  it('rolls back audit with the caller transaction', async () => {
    const rollback = new Error('MOCK rollback');
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.append({ merchantId, actorUserId: userId, record }, tx);
        throw rollback;
      }),
    ).rejects.toThrow(rollback);
    expect(await prisma.auditEvent.count({ where: { merchantId } })).toBe(0);
  });

  it('paginates tied timestamps and isolates the authorized merchant', async () => {
    await prisma.$transaction(async (tx) => {
      await audit.append({ merchantId, actorUserId: userId, record }, tx);
      await audit.append({ merchantId, actorUserId: userId, record }, tx);
      await audit.append(
        { merchantId: randomUUID(), actorUserId: userId, record },
        tx,
      );
    });
    const get = (query = '') =>
      request(context.app.getHttpServer())
        .get(`/api/activity${query}`)
        .auth(token, { type: 'bearer' });
    const first = ActivityResponseSchema.parse(
      (await get('?limit=1').expect(200)).body,
    );
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.merchantId).toBe(merchantId);
    expect(first.nextCursor).not.toBeNull();
    const cursor = new URLSearchParams({ limit: '1', ...first.nextCursor! });
    const second = ActivityResponseSchema.parse(
      (await get(`?${cursor}`).expect(200)).body,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.nextCursor).toBeNull();
    await get('?limit=101').expect(400);
    await get('?beforeId=' + randomUUID()).expect(400);
    await request(context.app.getHttpServer()).get('/api/activity').expect(401);
    await request(context.app.getHttpServer())
      .get('/api/activity')
      .auth(await issuer.token(randomUUID()), { type: 'bearer' })
      .expect(403);
    await request(context.app.getHttpServer())
      .post('/api/activity')
      .send({ record })
      .expect(404);
  });

  it('rejects UPDATE, DELETE and TRUNCATE, even as the owner', async () => {
    await expect(
      prisma.$executeRaw`UPDATE audit_events SET record = '{}' WHERE merchant_id = ${merchantId}::uuid`,
    ).rejects.toThrow('append-only');
    await expect(
      prisma.$executeRaw`DELETE FROM audit_events WHERE merchant_id = ${merchantId}::uuid`,
    ).rejects.toThrow('append-only');
    await expect(prisma.$executeRaw`TRUNCATE audit_events`).rejects.toThrow(
      'append-only',
    );
  });

  it('filters by module, action, outcome, date and related resource; metrics exclude other merchants', async () => {
    const transactionId = randomUUID(),
      runId = randomUUID();
    const from = new Date().toISOString();
    const event = {
      merchantId,
      actorUserId: userId,
      actorKind: 'AGENT' as const,
      transactionId,
      resourceType: 'INVESTIGATION' as const,
      resourceId: runId,
      durationMs: 120,
      inputTokens: 17,
      outputTokens: 9,
      record: {
        action: 'INVESTIGATION_FINISHED' as const,
        details: { provider: 'NVIDIA' as const },
      },
    };
    await audit.append(event);
    await audit.append({
      ...event,
      merchantId: randomUUID(),
      inputTokens: 999999,
    });
    const filters = new URLSearchParams({
      module: 'M05',
      action: 'INVESTIGATION_FINISHED',
      outcome: 'SUCCEEDED',
      transactionId,
      resourceId: runId,
      resourceType: 'INVESTIGATION',
      from,
      to: new Date().toISOString(),
    });
    const response = await request(context.app.getHttpServer())
      .get('/api/activity?' + filters)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const page = ActivityResponseSchema.parse(response.body);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      module: 'M05',
      transactionId,
      resourceId: runId,
      inputTokens: 17,
    });
    const metrics = MonitoringMetricsResponseSchema.parse(
      (
        await request(context.app.getHttpServer())
          .get('/api/activity/metrics?hours=1')
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body,
    );
    expect(metrics.groups.find((g) => g.module === 'M05')).toMatchObject({
      count: 1,
      inputTokens: 17,
      outputTokens: 9,
      averageDurationMs: 120,
      durationSamples: 1,
    });
    expect(metrics.current).toEqual({
      ingestion: [],
      orderSources: [],
      investigations: [],
      verifications: [],
    });
    await request(context.app.getHttpServer())
      .get('/api/activity/metrics')
      .expect(401);
    await request(context.app.getHttpServer())
      .get('/api/activity/metrics?hours=745')
      .auth(token, { type: 'bearer' })
      .expect(400);
    await request(context.app.getHttpServer())
      .get('/api/activity?module=M08')
      .auth(token, { type: 'bearer' })
      .expect(400);
  });

  it('rejects private metadata without creating a row', async () => {
    const before = await prisma.auditEvent.count({ where: { merchantId } });
    await expect(
      audit.append({
        merchantId,
        actorUserId: userId,
        record: {
          action: 'INVESTIGATION_STEP',
          details: { prompt: 'MOCK PRIVATE CONTENT' },
        },
      } as never),
    ).rejects.toThrow();
    expect(await prisma.auditEvent.count({ where: { merchantId } })).toBe(
      before,
    );
  });

  it('denies direct reads to an unprivileged PostgreSQL role', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE pg_read_all_data`;
      const rows = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM audit_events`;
      expect(rows[0]?.count).toBe(0n);
    });
  });
});
