import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';

describe('M01 protected routes without external configuration', () => {
  let context: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://localhost:1/unavailable',
      },
      false,
    );
    await context.app.init();
  });
  afterAll(async () => {
    await context?.app.close();
  });

  it.each([
    ['get', '/api/merchants/me'],
    ['get', '/api/transactions'],
    ['get', '/api/orders'],
    ['post', '/api/orders'],
    ['get', '/api/orders/00000000-0000-4000-8000-000000000000'],
    ['get', '/api/transactions/00000000-0000-4000-8000-000000000000/evidence'],
    ['post', '/api/transactions/00000000-0000-4000-8000-000000000000/evidence'],
    [
      'post',
      '/api/transactions/00000000-0000-4000-8000-000000000000/refresh-evidence',
    ],
    ['get', '/api/transactions/00000000-0000-4000-8000-000000000000'],
    ['get', '/api/settings/integrations'],
    ['patch', '/api/merchants/me/settings'],
    ['post', '/api/settings/integrations/paypal/check'],
  ] as const)(
    'requires user authentication for %s %s',
    async (method, path) => {
      const agent = request(context.app.getHttpServer());
      const response = await agent[method](path).expect(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    },
  );
  it('fails closed when a token is supplied but Supabase is unconfigured', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/merchants/me')
      .auth('MOCK_TOKEN', { type: 'bearer' })
      .expect(503);
    expect(response.body.code).toBe('AUTH_NOT_CONFIGURED');
    expect(response.body.message).not.toContain('Database');
  });
});
