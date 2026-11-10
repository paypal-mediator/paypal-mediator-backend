import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ApiErrorSchema, HealthResponseSchema } from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';

describe('HTTP foundation (real Nest app, unavailable database)', () => {
  let context: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres:password@127.0.0.1:1/unavailable',
        DB_CONNECTION_TIMEOUT_MS: '200',
      },
      false,
    );
    await context.app.init();
  });
  afterAll(async () => {
    await context?.app.close();
  });

  it('reports liveness without claiming database connectivity', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(HealthResponseSchema.parse(response.body).status).toBe('ok');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('fails readiness honestly when PostgreSQL is unavailable', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/health/ready')
      .expect(503);
    expect(ApiErrorSchema.parse(response.body).code).toBe('SERVICE_NOT_READY');
    expect(JSON.stringify(response.body)).not.toContain('password');
  });

  it('returns a uniform 404 correlated with the response header', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/not-implemented')
      .expect(404);
    expect(ApiErrorSchema.parse(response.body).requestId).toBe(
      response.headers['x-request-id'],
    );
  });

  it('allows the configured frontend origin and exposes request IDs', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/health')
      .set('Origin', 'http://localhost:3000')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
    expect(response.headers['access-control-expose-headers']).toBe(
      'X-Request-Id',
    );
  });

  it('does not grant CORS access to unconfigured origins', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/health')
      .set('Origin', 'https://untrusted.example')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('normalizes malformed JSON errors without echoing the input', async () => {
    const response = await request(context.app.getHttpServer())
      .post('/api/not-implemented')
      .set('Content-Type', 'application/json')
      .send('{"secret":"private-value"')
      .expect(400);
    expect(ApiErrorSchema.safeParse(response.body).success).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('private-value');
  });

  it('does not echo invalid JSON tokens through parser messages', async () => {
    const response = await request(context.app.getHttpServer())
      .post('/api/not-implemented')
      .set('Content-Type', 'application/json')
      .send('{"secret":private-value}')
      .expect(400);
    expect(ApiErrorSchema.parse(response.body).message).toBe('Bad Request');
    expect(JSON.stringify(response.body)).not.toContain('private-value');
  });

  it('serves OpenAPI with implemented endpoints only', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/openapi.json')
      .expect(200);
    expect(Object.keys(response.body.paths)).toEqual([
      '/api/health',
      '/api/health/ready',
      '/api/merchants/me',
      '/api/merchants',
      '/api/merchants/me/settings',
      '/api/settings/integrations',
      '/api/settings/integrations/paypal/check',
      '/api/webhooks/paypal',
      '/api/transactions/{id}/refresh-order-sources',
      '/api/transactions/{id}/evidence/files',
      '/api/transactions/{id}/evidence/files/{evidenceId}',
      '/api/transactions',
      '/api/transactions/{id}',
      '/api/transactions/{id}/refresh-evidence',
      '/api/transactions/{id}/evidence',
      '/api/orders',
      '/api/orders/{id}',
      '/api/transactions/{transactionId}/investigations',
      '/api/transactions/{transactionId}/investigations/{id}',
      '/api/transactions/{transactionId}/investigations/{investigationId}/verifications',
      '/api/transactions/{transactionId}/investigations/{investigationId}/verifications/{id}',
      '/api/activity/metrics',
      '/api/activity',
      '/api/dashboard',
      '/api/disputes',
      '/api/disputes/{id}',
      '/api/disputes/{id}/submit',
      '/api/billing/plans',
      '/api/billing/subscription',
      '/api/integrations/catalog',
      '/api/integrations',
      '/api/integrations/{provider}/start',
      '/api/integrations/{provider}/connect-with-key',
      '/api/integrations/{connectionId}/status',
      '/api/integrations/{connectionId}/sync',
      '/api/integrations/{connectionId}/disconnect',
      '/api/integrations/transactions/{captureId}/linked-records',
      '/api/integrations/disputes/{disputeId}/evidence-sources',
    ]);
    await request(context.app.getHttpServer()).get('/api/docs/').expect(200);
  });
});

it('disables Swagger by default in production', async () => {
  const { app } = await createApp(
    {
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://merchant.example',
      DATABASE_URL: 'postgresql://postgres:password@127.0.0.1:1/unavailable',
    },
    false,
  );
  try {
    await app.init();
    await request(app.getHttpServer()).get('/api/openapi.json').expect(404);
    await request(app.getHttpServer()).get('/api/docs').expect(404);
  } finally {
    await app.close();
  }
});
