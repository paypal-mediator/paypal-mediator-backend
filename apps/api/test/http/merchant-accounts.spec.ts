import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { createMockAuth } from '../fixtures/auth.js';

describe('Accounts without teams (MOCK database and signed identity issuer)', () => {
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let context: Awaited<ReturnType<typeof createApp>>;
  let prisma: PrismaService;
  const userId = randomUUID();

  beforeAll(async () => {
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://localhost:1/unavailable',
        SUPABASE_URL: issuer.origin,
        MERCHANT_ID: randomUUID(),
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    vi.spyOn(prisma.merchantMember, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.merchantMember, 'findFirst').mockResolvedValue(null);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await context?.app.close();
    await issuer?.close();
  });

  it('still requires authentication to list teams', async () => {
    await request(context.app.getHttpServer())
      .get('/api/merchants')
      .expect(401);
    expect(prisma.merchantMember.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty list for an authenticated account without granting merchant access', async () => {
    const token = await issuer.token(userId);
    const response = await request(context.app.getHttpServer())
      .get('/api/merchants?authUserId=00000000-0000-4000-8000-000000000001')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.body).toEqual({ items: [] });
    expect(prisma.merchantMember.findMany).toHaveBeenCalledWith({
      where: { authUserId: userId, active: true },
      include: { merchant: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const path of [
      '/api/merchants/me',
      '/api/transactions',
      '/api/activity',
    ]) {
      const denied = await request(context.app.getHttpServer())
        .get(path)
        .auth(token, { type: 'bearer' })
        .expect(403);
      expect(denied.body.code).toBe('MERCHANT_ACCESS_DENIED');
    }
  });
});
