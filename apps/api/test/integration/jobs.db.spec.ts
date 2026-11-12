import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { encryptErpSecret } from '../../src/common/crypto/secret-box.js';
import { JobsService } from '../../src/modules/jobs/jobs.service.js';
import { IntegrationsService } from '../../src/modules/integrations/integrations.service.js';

describe('ERP_SYNC durable worker (real PostgreSQL, explicitly MOCK ERP)', () => {
  const merchantId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>;
  let prisma: PrismaService;
  let inspector: PgBoss;
  let integrations: IntegrationsService;
  let jobs: JobsService;
  let connectionId: string;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'TEST_DATABASE_URL must point to a migrated disposable database',
      );
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MASTER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    integrations = context.app.get(IntegrationsService);
    jobs = context.app.get(JobsService);
    inspector = new PgBoss(process.env.TEST_DATABASE_URL);
    inspector.on('error', () => {});
    await inspector.start();
    await prisma.merchant.create({
      data: { id: merchantId, displayName: 'MOCK ERP queue integration' },
    });
    // Internal MOCK fixture: public connection creation intentionally accepts only Odoo.
    const encryptedPayload = await encryptErpSecret(
      { apiKey: 'EXPLICIT_MOCK' },
      context.environment,
    );
    const connection = await prisma.erpConnection.create({
      data: {
        merchantId,
        provider: 'mock-erp',
        status: 'connected',
        secret: { create: { encryptedPayload, keyVersion: 1 } },
      },
    });
    connectionId = connection.id;
  }, 30000);

  afterAll(async () => {
    await context?.app.close();
    if (inspector) {
      await inspector.stop();
    }
    // Keep append-only audit events. Delete only this suite's ERP fixtures.
    if (prisma) {
      await prisma.transactionLink.deleteMany({ where: { merchantId } });
      await prisma.externalRecord.deleteMany({ where: { merchantId } });
      await prisma.erpSyncCursor.deleteMany({ where: { connectionId } });
      await prisma.erpSecret.deleteMany({ where: { connectionId } });
      await prisma.erpConnection.deleteMany({ where: { merchantId } });
      await prisma.merchant.deleteMany({ where: { id: merchantId } });
      await prisma.$disconnect();
    }
  });

  it('creates the queue, processes records, completes pg-boss jobs and writes tenant audit', async () => {
    expect(jobs.isConnected()).toBe(true);
    const result = await integrations.sync(merchantId, connectionId);
    expect(result.ok).toBe(true);
    await expect
      .poll(
        async () => prisma.externalRecord.count({ where: { merchantId } }),
        { timeout: 10000 },
      )
      .toBe(2);
    await expect
      .poll(
        async () =>
          prisma.auditEvent.count({
            where: {
              merchantId,
              resourceType: 'INGESTION_JOB',
              outcome: 'SUCCEEDED',
            },
          }),
        { timeout: 10000 },
      )
      .toBe(3);
    await expect
      .poll(
        async () => {
          const rows = await prisma.$queryRaw<
            Array<{ state: string }>
          >`SELECT state FROM pgboss.job WHERE name = 'ERP_SYNC' AND data->>'merchantId' = ${merchantId}`;
          return (
            rows.length === 3 && rows.every((row) => row.state === 'completed')
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);
    expect(
      await prisma.erpSyncCursor.count({
        where: { connectionId, lastError: null },
      }),
    ).toBe(3);
    expect(
      await prisma.auditEvent.count({
        where: { merchantId, resourceId: connectionId, outcome: 'SUCCEEDED' },
      }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('persists supported retry, delay and timeout options in PostgreSQL', async () => {
    const id = await jobs.enqueue(
      'ERP_SYNC',
      { merchantId, explicitMock: true },
      { retries: 4, delay: 60000, ttl: 1501 },
    );
    const [stored] = await prisma.$queryRaw<
      Array<{ retry_limit: number; expire_seconds: number; delayed: boolean }>
    >`SELECT retry_limit, expire_seconds, start_after > now() + interval '45 seconds' AS delayed FROM pgboss.job WHERE id = ${id}::uuid`;
    expect(stored).toEqual({
      retry_limit: 4,
      expire_seconds: 2,
      delayed: true,
    });
    await inspector.cancel('ERP_SYNC', id);
  });

  it('keeps failed handler jobs failed with a merchant-scoped failure audit', async () => {
    const id = await jobs.enqueue(
      'ERP_SYNC',
      {
        merchantId,
        connectionId: randomUUID(),
        provider: 'mock-erp',
        resource: 'invoices',
        cursor: null,
      },
      { retries: 0 },
    );
    await expect
      .poll(
        async () => {
          const [row] = await prisma.$queryRaw<
            Array<{ state: string }>
          >`SELECT state FROM pgboss.job WHERE id = ${id}::uuid`;
          return row?.state;
        },
        { timeout: 10000 },
      )
      .toBe('failed');
    expect(
      await prisma.auditEvent.count({
        where: { merchantId, resourceId: id, outcome: 'FAILED' },
      }),
    ).toBe(1);
  });
});
