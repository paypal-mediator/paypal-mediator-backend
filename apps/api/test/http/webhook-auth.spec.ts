import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import {
  mockTransmissionHeaders,
  mockWebhookEvent,
} from '../fixtures/paypal-webhook.js';

describe('M02 public route fails closed without integration configuration', () => {
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
  it('rejects requests without transmission headers instead of accepting a merchant JWT', async () => {
    const response = await request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .auth('MOCK_USER_TOKEN', { type: 'bearer' })
      .send(mockWebhookEvent())
      .expect(400);
    expect(response.body.code).toBe('INVALID_WEBHOOK_HEADERS');
  });
  it('rejects non-JSON deliveries', async () => {
    await request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .type('text')
      .send('DEMO / MOCK')
      .expect(415);
  });
  it('requires a configured M01 merchant, credentials and webhook ID', async () => {
    const response = await request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(mockWebhookEvent())
      .expect(503);
    expect(response.body.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });
  it('enforces the body size limit before making external calls', async () => {
    await request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send({ ...mockWebhookEvent(), padding: 'x'.repeat(1024 * 1024) })
      .expect(413);
  });
});
