import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { TransactionsService } from '../../src/modules/transactions/index.js';
import { OrderSourcesService } from '../../src/modules/transactions/sources/order-sources.service.js';
import {
  ORDER_INFORMATION_SOURCES,
  type OrderInformationSource,
} from '../../src/modules/transactions/sources/order-information-source.js';
import { normalizePayPalOrder } from '../../src/modules/transactions/sources/paypal-order-normalizer.js';
import { createMockAuth } from '../fixtures/auth.js';
import { captureEvent } from '../fixtures/capture.js';
import { mockTransmissionHeaders } from '../fixtures/paypal-webhook.js';
import { mockPayPalOrder } from '../fixtures/paypal-order.js';
import { contentHash } from '../../src/common/data/content-hash.js';
import { EvidenceService } from '../../src/modules/evidence/index.js';

describe('order enrichment: real PostgreSQL/HTTP, explicitly MOCK PayPal/JWKS/ERP', () => {
  const merchantId = randomUUID(),
    userId = randomUUID(),
    viewerId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>,
    issuer: Awaited<ReturnType<typeof createMockAuth>>,
    prisma: PrismaService,
    transactions: TransactionsService,
    sources: OrderSourcesService,
    token: string,
    viewer: string;
  let mode: 'ok' | '500' | '404' | 'sparse' | 'conflict' = 'ok';
  let calls = 0;
  let sequence = 0;
  beforeAll(async () => {
    issuer = await createMockAuth();
    const native = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api-m.sandbox.paypal.com/'))
        return native(input, init);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({
          access_token: 'MOCKTOKEN',
          token_type: 'Bearer',
          expires_in: 300,
        });
      if (url.endsWith('/verify-webhook-signature'))
        return Response.json({ verification_status: 'SUCCESS' });
      if (url.includes('/v2/checkout/orders/')) {
        calls++;
        if (mode === '500' || mode === '404')
          return new Response('MOCKSECRET', { status: Number(mode) });
        const id = url.split('/').at(-1)!;
        const original = mockPayPalOrder(id, `CAP${id}`);
        if (mode === 'sparse')
          return Response.json({
            ...original,
            purchase_units: [
              {
                payments: original.purchase_units[0]!.payments,
                amount: { currency_code: 'USD', value: '1.00' },
              },
            ],
          });
        if (mode === 'conflict')
          original.purchase_units[0]!.amount.value = '2.00';
        return Response.json(original);
      }
      throw new Error('UNEXPECTED_MOCK_CALL');
    });
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MERCHANT_ID: merchantId,
        SUPABASE_URL: issuer.origin,
        PAYPAL_CLIENT_ID: 'MOCK',
        PAYPAL_CLIENT_SECRET: 'MOCK',
        PAYPAL_WEBHOOK_ID: 'MOCK',
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    transactions = context.app.get(TransactionsService);
    sources = context.app.get(OrderSourcesService);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'MOCK multi-source',
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
    vi.restoreAllMocks();
    if (prisma) {
      const where = { merchantId };
      await prisma.evidenceItem.deleteMany({ where: { dossier: where } });
      await prisma.evidenceDossier.deleteMany({ where });
      await prisma.transaction.deleteMany({ where });
      await prisma.ingestionJob.deleteMany({ where: { event: where } });
      await prisma.webhookEvent.deleteMany({ where });
      await prisma.merchantMember.deleteMany({ where });
      await prisma.merchant.deleteMany({ where: { id: merchantId } });
    }
    await context?.app.close();
    await issuer?.close();
  });
  const http = () => request(context.app.getHttpServer());
  async function capture() {
    const orderId = `MOCKORDER${++sequence}`;
    const event = captureEvent(`CAP${orderId}`);
    event.resource.amount.value = '1.00';
    event.resource.custom_id = 'MOCKREFERENCE';
    event.resource.supplementary_data.related_ids.order_id = orderId;
    const receipt = await http()
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(event)
      .expect(200);
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    const row = await prisma.transaction.findUniqueOrThrow({
      where: { sourceEventId: receipt.body.eventId },
    });
    return {
      row,
      event,
      receipt: receipt.body as { eventId: string; jobId: string },
    };
  }
  it('enqueues only after verified capture; fetches and persists originals with PayPal provenance without a manual order', async () => {
    const before = calls;
    const { row, receipt, event } = await capture();
    expect(calls).toBe(before);
    expect(
      (await transactions.detail(merchantId, row.id)).orderEnrichment.status,
    ).toBe('PENDING');
    mode = 'ok';
    expect(await sources.processNext(merchantId)).toBe('PROCESSED');
    const result = await http()
      .get(`/api/transactions/${row.id}`)
      .auth(viewer, { type: 'bearer' })
      .expect(200);
    expect(result.body).toMatchObject({
      orderLink: { status: 'LINKED' },
      orderEnrichment: { status: 'COMPLETE' },
      order: {
        sourceKind: 'PAYPAL',
        totalAmount: '1.00',
        items: [
          { sku: 'MOCKA', quantity: 2, unitAmount: '0.30' },
          { sku: 'MOCKB', quantity: 1, unitAmount: '0.20' },
        ],
      },
      readiness: { status: 'INCOMPLETE', containsDemo: false },
    });
    expect(await prisma.merchantOrder.count({ where: { merchantId } })).toBe(0);
    expect(
      (
        await prisma.ingestionJob.findUniqueOrThrow({
          where: { id: receipt.jobId },
        })
      ).status,
    ).toBe('COMPLETED');
    const dossier = await transactions.dossier(merchantId, row.id);
    expect(dossier.items.map((i) => i.type).sort()).toEqual([
      'ORDER_RECORD',
      'ORDER_SOURCE_RECORD',
      'PAYMENT_RECORD',
    ]);
    const raw = dossier.items.find((i) => i.type === 'ORDER_SOURCE_RECORD')!;
    expect(raw.sourceKind).toBe('PAYPAL');
    expect(raw.contentHash).toBe(contentHash(raw.content));
    expect(raw.content).toMatchObject({
      original: mockPayPalOrder(row.paypalOrderId!, row.paypalCaptureId),
    });
    const revision = dossier.revision;
    await http()
      .post(`/api/transactions/${row.id}/refresh-order-sources`)
      .auth(token, { type: 'bearer' })
      .expect(201);
    expect((await transactions.dossier(merchantId, row.id)).revision).toBe(
      revision,
    );
    await http()
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(event)
      .expect(200);
    expect(await transactions.processNextCapture(merchantId)).toBe('EMPTY');
    expect(
      await prisma.orderSourceJob.count({ where: { transactionId: row.id } }),
    ).toBe(1);
    await http().get(`/api/transactions/${row.id}`).expect(401);
    await http()
      .post(`/api/transactions/${row.id}/refresh-order-sources`)
      .auth(viewer, { type: 'bearer' })
      .expect(403);
    await expect(
      transactions.refreshOrderSources(
        { merchantId: randomUUID(), userId, role: 'ADMIN' },
        row.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('keeps verified capture completed on timeout/HTTP failure, retries and retains last successful originals', async () => {
    const { row, receipt } = await capture();
    mode = '500';
    expect(await sources.processNext(merchantId)).toBe('FAILED');
    let detail = await transactions.detail(merchantId, row.id);
    expect(detail.orderEnrichment.records[0]).toMatchObject({
      status: 'FAILED',
      errorCode: 'PAYPAL_ORDER_HTTP_ERROR',
      httpStatus: 500,
      attempts: 1,
    });
    expect(detail.orderEnrichment.records[0]!.nextAttemptAt).not.toBeNull();
    expect(
      (
        await prisma.ingestionJob.findUniqueOrThrow({
          where: { id: receipt.jobId },
        })
      ).status,
    ).toBe('COMPLETED');
    expect(await sources.processNext(merchantId)).toBe('EMPTY');
    await prisma.orderSourceJob.updateMany({
      where: { transactionId: row.id },
      data: { nextAttemptAt: new Date(0) },
    });
    mode = 'ok';
    expect(await sources.processNext(merchantId)).toBe('PROCESSED');
    const revision = (await transactions.dossier(merchantId, row.id)).revision;
    mode = '404';
    await sources.refresh(merchantId, row.id);
    detail = await transactions.detail(merchantId, row.id);
    expect(detail.orderEnrichment.records[0]).toMatchObject({
      status: 'FAILED',
      httpStatus: 404,
      nextAttemptAt: null,
      integrity: 'VALID',
    });
    expect(detail.order?.sourceKind).toBe('PAYPAL');
    expect((await transactions.dossier(merchantId, row.id)).revision).toBe(
      revision,
    );
  });
  it('backfills old captures without inventing absent fields, then preserves new versions and contradictions', async () => {
    const { row } = await capture();
    await prisma.orderSourceJob.deleteMany({
      where: { transactionId: row.id },
    });
    mode = 'sparse';
    await sources.refresh(merchantId, row.id);
    let detail = await transactions.detail(merchantId, row.id);
    expect(detail).toMatchObject({
      orderEnrichment: { status: 'PARTIAL' },
      order: { items: [], shippingAmount: null },
      readiness: { status: 'INCOMPLETE' },
    });
    const old = (await transactions.dossier(merchantId, row.id)).items.find(
      (i) => i.type === 'ORDER_SOURCE_RECORD',
    )!;
    mode = 'conflict';
    await sources.refresh(merchantId, row.id);
    detail = await transactions.detail(merchantId, row.id);
    expect(detail).toMatchObject({
      orderEnrichment: { status: 'CONFLICT' },
      orderLink: { status: 'CONFLICT' },
      readiness: { status: 'NEEDS_REVIEW' },
    });
    expect(
      (await transactions.dossier(merchantId, row.id)).items.find(
        (i) => i.id === old.id,
      )!.contentHash,
    ).toBe(old.contentHash);
  });
  it('leases work once across consumers and recovers an expired lease', async () => {
    const { row } = await capture();
    mode = 'ok';
    expect(
      (
        await Promise.all([
          sources.processNext(merchantId),
          sources.processNext(merchantId),
        ])
      ).sort(),
    ).toEqual(['EMPTY', 'PROCESSED']);
    await prisma.orderSourceJob.updateMany({
      where: { transactionId: row.id },
      data: {
        status: 'FETCHING',
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(0),
      },
    });
    expect(await sources.processNext(merchantId)).toBe('PROCESSED');
  });
  it('caps automatic retries at five and permits explicit administrative recovery', async () => {
    const { row } = await capture();
    mode = '500';
    for (let i = 1; i <= 5; i++) {
      expect(await sources.processNext(merchantId)).toBe('FAILED');
      const job = await prisma.orderSourceJob.findFirstOrThrow({
        where: { transactionId: row.id },
      });
      expect(job.attempts).toBe(i);
      if (i < 5)
        await prisma.orderSourceJob.update({
          where: { id: job.id },
          data: { nextAttemptAt: new Date(0) },
        });
      else expect(job.nextAttemptAt).toBeNull();
    }
    expect(await sources.processNext(merchantId)).toBe('EMPTY');
    mode = 'ok';
    await sources.refresh(merchantId, row.id);
    expect(
      (await transactions.detail(merchantId, row.id)).orderEnrichment.status,
    ).toBe('COMPLETE');
  });
  it('keeps the capture when M04 persistence fails and sanitizes internal errors', async () => {
    const { row } = await capture();
    mode = 'ok';
    const vault = context.app.get(EvidenceService);
    const spy = vi
      .spyOn(vault, 'recordOrderSource')
      .mockRejectedValueOnce(new Error('MOCK_SECRET_DATABASE_ERROR'));
    expect(await sources.processNext(merchantId)).toBe('FAILED');
    spy.mockRestore();
    const detail = await transactions.detail(merchantId, row.id);
    expect(detail.orderEnrichment.records[0]!.errorCode).toBe(
      'ORDER_SOURCE_PROCESSING_FAILED',
    );
    expect(JSON.stringify(detail)).not.toContain('MOCK_SECRET');
    expect(detail.paypalCaptureId).toBe(row.paypalCaptureId);
    expect((await transactions.dossier(merchantId, row.id)).items).toHaveLength(
      1,
    );
    await sources.refresh(merchantId, row.id);
    expect(
      (await transactions.detail(merchantId, row.id)).orderEnrichment.status,
    ).toBe('COMPLETE');
  });
  it('detects tampered normalized source data and protects trusted provenance from HTTP input', async () => {
    const { row } = await capture();
    mode = 'ok';
    await sources.processNext(merchantId);
    await prisma.orderSourceJob.updateMany({
      where: { transactionId: row.id },
      data: { contentHash: '0'.repeat(64) },
    });
    const detail = await transactions.detail(merchantId, row.id);
    expect(detail).toMatchObject({
      order: null,
      orderLink: { status: 'CONFLICT' },
      readiness: { status: 'NEEDS_REVIEW' },
    });
    expect(detail.orderEnrichment.records[0]!.integrity).toBe('INVALID');
    await http()
      .post('/api/orders')
      .auth(token, { type: 'bearer' })
      .send({ sourceKind: 'PAYPAL' })
      .expect(400);
    await http()
      .post(`/api/transactions/${row.id}/evidence`)
      .auth(token, { type: 'bearer' })
      .send({ type: 'ORDER_SOURCE_RECORD', sourceKind: 'CONNECTED_SYSTEM' })
      .expect(400);
    await sources.refresh(merchantId, row.id);
  });
  it('accepts a separate server registered ERP adapter and exposes conflicts without replacing PayPal', async () => {
    const registry = context.app.get<OrderInformationSource[]>(
      ORDER_INFORMATION_SOURCES,
    );
    registry.push({
      providerId: 'MOCK_ERP',
      sourceKind: 'CONNECTED_SYSTEM',
      sourceSystem: 'MOCK ERP',
      supports: () => true,
      fetch: async (row) => {
        const result = normalizePayPalOrder(
          mockPayPalOrder(row.paypalOrderId!, row.paypalCaptureId),
          row,
        );
        result.order = {
          ...result.order!,
          providerId: 'MOCK_ERP',
          sourceKind: 'CONNECTED_SYSTEM',
          sourceSystem: 'MOCK ERP',
          totalAmount: '2.00',
        };
        return {
          original: { explicitMock: true, totalAmount: '2.00' },
          result,
        };
      },
    });
    const { row } = await capture();
    mode = 'ok';
    await sources.processNext(merchantId);
    await sources.processNext(merchantId);
    const detail = await transactions.detail(merchantId, row.id);
    expect(
      detail.orderEnrichment.records.map((r) => r.providerId).sort(),
    ).toEqual(['MOCK_ERP', 'PAYPAL']);
    expect(detail.readiness.status).toBe('NEEDS_REVIEW');
    expect(detail.orderEnrichment.status).toBe('CONFLICT');
    expect(detail.orderLink.status).toBe('CONFLICT');
    expect(
      (await transactions.dossier(merchantId, row.id)).items
        .filter((i) => i.type === 'ORDER_SOURCE_RECORD')
        .map((i) => i.sourceKind)
        .sort(),
    ).toEqual(['CONNECTED_SYSTEM', 'PAYPAL']);
    registry.pop();
  });
});
