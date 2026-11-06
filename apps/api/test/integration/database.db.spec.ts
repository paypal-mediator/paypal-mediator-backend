import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ReadinessResponseSchema } from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';

describe('PostgreSQL integration (requires migrated test database)', () => {
  let context: Awaited<ReturnType<typeof createApp>>;
  let prisma: PrismaService;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error(
        'TEST_DATABASE_URL must point to a migrated disposable test database',
      );
    }
    context = await createApp(
      { NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
  });
  afterAll(async () => {
    await context?.app.close();
  });

  it('confirms readiness using a real SELECT 1', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/health/ready')
      .expect(200);
    expect(ReadinessResponseSchema.parse(response.body).checks.database).toBe(
      'up',
    );
  });

  it('uses the migrated merchant table and rolls back test data', async () => {
    const id = randomUUID();
    class RollbackTest extends Error {}
    await expect(
      prisma.$transaction(async (tx) => {
        const created = await tx.merchant.create({
          data: { id, displayName: 'TEST ONLY' },
        });
        expect(created.id).toBe(id);
        const updated = await tx.merchant.update({
          where: { id },
          data: { displayName: 'TEST UPDATED' },
        });
        expect(updated.displayName).toBe('TEST UPDATED');
        throw new RollbackTest();
      }),
    ).rejects.toBeInstanceOf(RollbackTest);
    expect(await prisma.merchant.findUnique({ where: { id } })).toBeNull();
  });
});
