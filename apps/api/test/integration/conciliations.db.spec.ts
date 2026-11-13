import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { AgentProvider } from '../../src/modules/investigator/index.js';
import { OrdersService } from '../../src/modules/transactions/index.js';
import {
  ContactClassifier,
  fastContactClassification,
} from '../../src/modules/conciliations/contact-classifier.js';
import { createMockAuth } from '../fixtures/auth.js';
import { demoOrder } from '../fixtures/commerce.js';

describe('preventive conciliation: real PostgreSQL/HTTP, MOCK identity and NLP/LLM', () => {
  const merchantId = randomUUID(),
    otherId = randomUUID(),
    userId = randomUUID(),
    viewerId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>,
    issuer: Awaited<ReturnType<typeof createMockAuth>>,
    db: PrismaService,
    admin: string,
    viewer: string,
    orderId: string;
  let generationCount = 0;
  let generationGate: Promise<void> | undefined;
  const actor = { merchantId, userId, role: 'ADMIN' as const };
  const policy = { enabled: true, minScore: 0.9, rules: [] };
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error(
        'TEST_DATABASE_URL must point to a disposable test database',
      );
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        SUPABASE_URL: issuer.origin,
        MEDIATION_WORKER_ENABLED: 'false',
      },
      false,
    );
    await context.app.init();
    db = context.app.get(PrismaService);
    await db.merchant.create({
      data: {
        id: merchantId,
        displayName: 'MOCK preventive team',
        members: {
          create: [
            { authUserId: userId, role: 'ADMIN' },
            { authUserId: viewerId, role: 'VIEWER' },
          ],
        },
      },
    });
    await db.merchant.create({
      data: {
        id: otherId,
        displayName: 'MOCK other team',
        members: { create: { authUserId: userId, role: 'ADMIN' } },
      },
    });
    const order = await context.app
      .get(OrdersService)
      .create(actor, demoOrder(randomUUID()));
    orderId = order.order.id;
    admin = await issuer.token(userId);
    viewer = await issuer.token(viewerId);
    vi.spyOn(context.app.get(ContactClassifier), 'classify').mockImplementation(
      async (text) =>
        fastContactClassification(text) || {
          category: text.includes('dispute')
            ? 'DISPUTE_INTENT'
            : text.includes('?')
              ? 'QUESTION'
              : 'COMPLAINT',
          issue: 'SHIPPING',
          score: 0.99,
          margin: 0.9,
          source: 'LOCAL_NLP',
        },
    );
    vi.spyOn(
      context.app.get(AgentProvider),
      'structuredStep',
    ).mockImplementation(async (_messages, _signal, schema) => {
      generationCount++;
      if (generationGate) await generationGate;
      return {
        command: schema.parse({
          reply: 'MOCK draft: please confirm the missing item.',
          plan: 'MOCK request details; do not promise a refund.',
          needsHuman: false,
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
  });
  afterAll(async () => {
    await context?.app.close();
    await issuer?.close();
    vi.restoreAllMocks();
  });
  const server = () => context.app.getHttpServer();
  const get = (path: string, team = merchantId) =>
    request(server())
      .get(path)
      .auth(admin, { type: 'bearer' })
      .set('X-Merchant-Id', team);
  const post = (
    path: string,
    body: object = {},
    token = admin,
    team = merchantId,
  ) =>
    request(server())
      .post(path)
      .auth(token, { type: 'bearer' })
      .set('X-Merchant-Id', team)
      .send(body);
  const configure = (body: object) =>
    request(server())
      .put('/api/conciliations/policy')
      .auth(admin, { type: 'bearer' })
      .set('X-Merchant-Id', merchantId)
      .send(body);
  const link = async () =>
    (await post('/api/conciliations/links', { orderId }).expect(201)).body;
  const send = (token: string, text: string, key = randomUUID()) =>
    request(server())
      .post('/api/public/conciliations/messages')
      .set('X-Chat-Token', token)
      .send({ text, language: 'en', idempotencyKey: key });

  it('authorizes team access, hides token hashes and enables RLS on every new table', async () => {
    await request(server()).get('/api/conciliations').expect(401);
    await post('/api/conciliations/links', { orderId }, viewer).expect(403);
    await post('/api/conciliations/links', { orderId }, admin, otherId).expect(
      404,
    );
    const created = await link();
    await get(`/api/conciliations/${created.id}`, otherId).expect(404);
    const list = await get('/api/conciliations').expect(200);
    const detail = await get(`/api/conciliations/${created.id}`).expect(200);
    expect(detail.body.chat.orderSource).toMatchObject({
      kind: 'DEMO',
      checkoutOrigin: 'UNVERIFIED',
      receiptLinkStatus: 'CHECKOUT_INTEGRATION_REQUIRED',
    });
    expect(JSON.stringify(list.body)).not.toContain(created.token);
    expect(JSON.stringify(list.body)).not.toContain('tokenHash');
    await request(server())
      .get('/api/public/conciliations/chat')
      .set('X-Chat-Token', 'invalid')
      .expect(404);
    const flags = await db.$queryRaw<
      Array<{ relrowsecurity: boolean }>
    >`SELECT relrowsecurity FROM pg_class WHERE relname IN ('conciliation_policies','conciliation_chats','conciliation_messages')`;
    expect(flags).toHaveLength(3);
    expect(flags.every((f) => f.relrowsecurity)).toBe(true);
  });
  it('acknowledgements cause no LLM call and do not open a case', async () => {
    await configure(policy).expect(200);
    const created = await link(),
      before = generationCount;
    const key = randomUUID();
    await send(created.token, 'llego bien', key).expect(201);
    await send(created.token, 'llego bien', key).expect(201);
    expect(generationCount).toBe(before);
    const view = await get(`/api/conciliations/${created.id}`).expect(200);
    expect(view.body.chat.state).toBe('NO_ACTION');
    expect(view.body.messages).toHaveLength(1);
    expect(view.body.messages[0].classification.source).toBe('FAST_FILTER');
    await send(created.token, 'different body', key).expect(409);
  });
  it('keeps proposals private, sends the merchant-edited approval exactly once, and rejects stale drafts', async () => {
    const created = await link(),
      before = generationCount;
    const sent = await send(created.token, 'my parcel never arrived').expect(
      201,
    );
    expect(generationCount).toBe(before + 1);
    expect(sent.body.messages).toHaveLength(1);
    expect(sent.body.orderSource).toBeUndefined();
    expect(JSON.stringify(sent.body)).not.toContain('MOCK draft');
    let view = (await get(`/api/conciliations/${created.id}`).expect(200)).body;
    const source = view.messages[0];
    expect(source.policySnapshot.enabled).toBe(true);
    const approval = {
      messageId: source.id,
      expectedVersion: source.version,
      text: 'Merchant edited: we will review the delivery details.',
      idempotencyKey: randomUUID(),
    };
    await post(
      `/api/conciliations/${created.id}/approve`,
      approval,
      viewer,
    ).expect(403);
    await post(`/api/conciliations/${created.id}/approve`, approval).expect(
      201,
    );
    await post(`/api/conciliations/${created.id}/approve`, approval).expect(
      201,
    );
    const buyer = (
      await request(server())
        .get('/api/public/conciliations/chat')
        .set('X-Chat-Token', created.token)
        .expect(200)
    ).body;
    expect(buyer.messages).toHaveLength(2);
    expect(buyer.messages[1].text).toBe(approval.text);
    expect(buyer.messages[1].approvedBy).toBeUndefined();
    await send(created.token, 'another item was missing').expect(201);
    view = (await get(`/api/conciliations/${created.id}`)).body;
    const pending = view.messages.at(-1);
    await send(created.token, 'a third item is also missing').expect(201);
    await post(`/api/conciliations/${created.id}/approve`, {
      ...approval,
      messageId: pending.id,
      expectedVersion: pending.version,
      idempotencyKey: randomUUID(),
    }).expect(409);
  });
  it('automatic delivery uses only the enabled approved language template and no generator', async () => {
    const rule = {
      category: 'QUESTION',
      issue: 'SHIPPING',
      automatic: true,
      instructions: 'Ask for delivery details',
      replyEs: 'Revisaremos la entrega contigo.',
      replyEn: 'We will review delivery with you.',
    };
    await configure({ ...policy, rules: [rule] }).expect(200);
    const created = await link(),
      before = generationCount;
    const view = await send(created.token, 'Where is my order?').expect(201);
    expect(generationCount).toBe(before);
    expect(view.body.messages.at(-1).text).toBe(rule.replyEn);
    await send(created.token, 'I want to open a dispute').expect(201);
    expect(generationCount).toBe(before);
    const merchant = (await get(`/api/conciliations/${created.id}`)).body;
    expect(merchant.chat.state).toBe('REVIEW');
    await configure({ ...policy, enabled: false, rules: [rule] }).expect(200);
    const other = await link();
    const blocked = await send(other.token, 'Where is my order?').expect(201);
    expect(blocked.body.messages).toHaveLength(1);
    expect(generationCount).toBe(before);
  });
  it('closed, expired or revoked links cannot send, and interrupted processing can be taken over manually', async () => {
    const created = await link();
    await send(created.token, 'delivery problem').expect(201);
    await db.conciliationMessage.updateMany({
      where: { chatId: created.id },
      data: { draftStatus: 'PROCESSING' },
    });
    await post(`/api/conciliations/${created.id}/manual-review`).expect(201);
    const view = (await get(`/api/conciliations/${created.id}`)).body;
    expect(view.messages[0].draftStatus).toBe('PENDING');
    await post(`/api/conciliations/${created.id}/close`).expect(201);
    await send(created.token, 'new message').expect(409);
    await post(`/api/conciliations/${created.id}/revoke`).expect(201);
    await request(server())
      .get('/api/public/conciliations/chat')
      .set('X-Chat-Token', created.token)
      .expect(410);
    const expired = await link();
    await db.conciliationChat.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(0) },
    });
    await send(expired.token, 'hello').expect(410);
  });
  it('does not overwrite a human takeover with late generator output', async () => {
    await configure(policy).expect(200);
    const created = await link(),
      before = generationCount;
    let release!: () => void;
    generationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = send(created.token, 'delayed delivery problem').then(
      (response) => response,
    );
    try {
      await vi.waitFor(() => expect(generationCount).toBe(before + 1));
      await post(`/api/conciliations/${created.id}/manual-review`).expect(201);
      const view = (await get(`/api/conciliations/${created.id}`)).body;
      const source = view.messages[0];
      await post(`/api/conciliations/${created.id}/approve`, {
        messageId: source.id,
        expectedVersion: source.version,
        text: 'Human takeover reply',
        idempotencyKey: randomUUID(),
      }).expect(201);
    } finally {
      generationGate = undefined;
      release();
    }
    const result = await pending;
    expect(result.status).toBe(201);
    expect(result.body.messages).toHaveLength(2);
    expect(result.body.messages.at(-1).text).toBe('Human takeover reply');
  });
  it('keeps saturated messages for manual review and releases generator capacity', async () => {
    await configure(policy).expect(200);
    const first = await link();
    const second = await link();
    const before = generationCount;
    let release!: () => void;
    generationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = send(first.token, 'delivery problem').then((r) => r);
    try {
      await vi.waitFor(() => expect(generationCount).toBe(before + 1));
      const received = await send(
        second.token,
        'another delivery problem',
      ).expect(201);
      expect(received.body.messages).toHaveLength(1);
      expect(generationCount).toBe(before + 1);
      const view = (await get(`/api/conciliations/${second.id}`).expect(200))
        .body;
      expect(view.chat.state).toBe('REVIEW');
      expect(view.messages[0].draftStatus).toBe('PENDING');
      expect(view.messages[0].draftText).toBeNull();
      await post(`/api/conciliations/${second.id}/approve`, {
        messageId: view.messages[0].id,
        expectedVersion: view.messages[0].version,
        text: 'Manual response while the generator is occupied.',
        idempotencyKey: randomUUID(),
      }).expect(201);
    } finally {
      generationGate = undefined;
      release();
      await pending;
    }
    await send(first.token, 'another missing item').expect(201);
    expect(generationCount).toBe(before + 2);
  });
  it('deduplicates simultaneous buyer retries and applies the public message limit', async () => {
    const created = await link(),
      key = randomUUID(),
      before = generationCount;
    await Promise.all([
      send(created.token, 'thanks', key).expect(201),
      send(created.token, 'thanks', key).expect(201),
    ]);
    expect(
      (await get(`/api/conciliations/${created.id}`)).body.messages,
    ).toHaveLength(1);
    for (let index = 0; index < 19; index++)
      await send(created.token, 'thanks').expect(201);
    await send(created.token, 'thanks').expect(429);
    expect(generationCount).toBe(before);
  });
});
