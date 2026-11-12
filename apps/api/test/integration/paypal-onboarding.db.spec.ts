import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { PayPalAuthService } from '../../src/modules/merchants/index.js';
import { MerchantsService } from '../../src/modules/merchants/merchants.service.js';
import { createMockAuth } from '../fixtures/auth.js';

describe('PayPal seller onboarding: PostgreSQL and HTTP, MOCK PayPal and identity', () => {
  const merchantId = randomUUID(),
    other = randomUUID(),
    userId = randomUUID(),
    viewerId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>,
    issuer: Awaited<ReturnType<typeof createMockAuth>>,
    prisma: PrismaService;
  let token: string,
    viewer: string,
    trackingId = '',
    confirmed = true,
    returnedTracking = '',
    scopes = true;
  const fetcher = vi.fn<typeof fetch>();
  beforeAll(async () => {
    issuer = await createMockAuth();
    const realFetch = globalThis.fetch;
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api-m.sandbox.paypal.com'))
        return realFetch(input, init);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({
          access_token: 'MOCK',
          token_type: 'Bearer',
          expires_in: 300,
        });
      if (url.endsWith('/partner-referrals')) {
        trackingId = JSON.parse(String(init?.body)).tracking_id;
        return Response.json({
          links: [
            {
              rel: 'action_url',
              href: 'https://www.sandbox.paypal.com/merchant-onboarding',
            },
          ],
        });
      }
      const seller = {
        merchant_id: 'SELLER1234567',
        tracking_id: returnedTracking || trackingId,
      };
      if (url.includes('?tracking_id=')) return Response.json(seller);
      return Response.json({
        ...seller,
        primary_email_confirmed: confirmed,
        oauth_integrations: [
          {
            oauth_third_party: [
              {
                partner_client_id: 'MOCK_CLIENT',
                scopes: scopes
                  ? [
                      'https://uri.paypal.com/services/disputes/read-seller',
                      'https://uri.paypal.com/services/disputes/update-seller',
                    ]
                  : [],
              },
            ],
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetcher);
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        SUPABASE_URL: issuer.origin,
        PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
        PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
        PAYPAL_WEBHOOK_ID: 'MOCK_WEBHOOK',
        PAYPAL_PARTNER_MERCHANT_ID: 'PARTNER123456',
        PAYPAL_PARTNER_ATTRIBUTION_ID: 'MOCK_BN',
        PAYPAL_ONBOARDING_RETURN_URL: 'http://localhost:3000/',
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    for (const id of [merchantId, other])
      await prisma.merchant.create({
        data: {
          id,
          displayName: 'MOCK business',
          members: {
            create: [
              { authUserId: userId, role: 'ADMIN' },
              { authUserId: viewerId, role: 'VIEWER' },
            ],
          },
        },
      });
    token = await issuer.token(userId);
    viewer = await issuer.token(viewerId);
  });
  afterAll(async () => {
    await context?.app.close();
    // Historical events are retained; the database is disposable.
    await issuer?.close();
    vi.unstubAllGlobals();
  });
  const post = (action: string, id = merchantId, jwt = token) =>
    request(context.app.getHttpServer())
      .post(`/api/settings/integrations/paypal/${action}`)
      .auth(jwt, { type: 'bearer' })
      .set('X-Merchant-Id', id);

  it('blocks anonymous users, viewers and nonmembers before PayPal', async () => {
    const before = fetcher.mock.calls.filter(([url]) =>
      String(url).includes('api-m.sandbox'),
    ).length;
    await request(context.app.getHttpServer())
      .post('/api/settings/integrations/paypal/connect')
      .expect(401);
    await post('connect', merchantId, viewer).expect(403);
    await post('connect', randomUUID()).expect(403);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).includes('api-m.sandbox'),
      ),
    ).toHaveLength(before);
  });
  it('creates a real redirect with per-business tracking; does not mark pending as connected', async () => {
    const response = await post('connect').expect(201);
    expect(response.body.actionUrl).toMatch(
      /^https:\/\/www.sandbox.paypal.com\//,
    );
    const pending = await prisma.payPalAccount.findUniqueOrThrow({
      where: { merchantId },
    });
    expect(pending.status).toBe('PENDING');
    expect(pending.sellerId).toBeNull();
    expect(pending.trackingId).toBe(trackingId);
    const referral = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith('/partner-referrals'),
    )!;
    const body = JSON.parse(String(referral[1]?.body));
    expect(
      new URL(body.partner_config_override.return_url).searchParams.get(
        'paypalReturn',
      ),
    ).toBe(merchantId);
    expect(
      body.operations[0].api_integration_preference.rest_api_integration
        .third_party_details.features,
    ).not.toContain('REFUND');
  });
  it('rejects expired, unconfirmed, missing-permission and mismatched authorizations', async () => {
    confirmed = false;
    await post('complete').expect(409);
    confirmed = true;
    scopes = false;
    await post('complete').expect(409);
    scopes = true;
    returnedTracking = randomUUID();
    await post('complete').expect(409);
    returnedTracking = '';
    await prisma.payPalAccount.update({
      where: { merchantId },
      data: { expiresAt: new Date(0) },
    });
    await post('complete').expect(409);
    await post('connect').expect(201);
  });
  it('verifies seller consent server-side and scopes API calls to that seller', async () => {
    await post('complete').send({ merchantIdInPayPal: 'ATTACKER' }).expect(201);
    const account = await prisma.payPalAccount.findUniqueOrThrow({
      where: { merchantId },
    });
    expect(account.sellerId).toBe('SELLER1234567');
    expect(account.status).toBe('CONNECTED');
    const auth = context.app.get(PayPalAuthService);
    const headers = await auth.merchantHeaders(merchantId);
    const payload = headers['PayPal-Auth-Assertion']!.split('.')[1]!;
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iss: 'MOCK_CLIENT',
      payer_id: account.sellerId,
    });
    await expect(auth.merchantHeaders(other)).rejects.toThrow('Connect PayPal');
    const service = context.app.get(MerchantsService);
    expect(
      (await service.getIntegrations(merchantId)).paypal.connectionStatus,
    ).toBe('CONNECTED');
    expect((await service.getIntegrations(other)).paypal.connectionStatus).toBe(
      'NOT_CONFIGURED',
    );
    expect(
      await service.getPayPalWebhookContext({
        payee: { merchant_id: account.sellerId },
      }),
    ).toEqual({ merchantId, webhookId: 'MOCK_WEBHOOK' });
    await expect(
      service.getPayPalWebhookContext({ payee: { merchant_id: 'UNKNOWN' } }),
    ).rejects.toThrow('not connected');
    await expect(
      service.getPayPalWebhookContext({
        disputed_transactions: [
          { seller: { merchant_id: account.sellerId } },
          { seller: { merchant_id: 'OTHER' } },
        ],
      }),
    ).rejects.toThrow('exactly one');
  });
  it('prevents the same seller being linked to another business', async () => {
    await post('connect', other).expect(201);
    await post('complete', other).expect(409);
    expect(
      (
        await prisma.payPalAccount.findUniqueOrThrow({
          where: { merchantId: other },
        })
      ).status,
    ).toBe('PENDING');
  });
  it('disconnects locally and prevents authorization replay and API access', async () => {
    await post('disconnect').expect(201);
    await post('complete').expect(409);
    await expect(
      context.app.get(PayPalAuthService).merchantHeaders(merchantId),
    ).rejects.toThrow('Connect PayPal');
  });
});
