import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  OrderReceiptSchema,
  EvidenceDossierResponseSchema,
  type CreateOrder,
} from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import {
  OrdersService,
  TransactionsService,
} from '../../src/modules/transactions/index.js';
import type { MerchantActor } from '../../src/modules/merchants/index.js';
import { EvidenceService } from '../../src/modules/evidence/index.js';
import { contentHash } from '../../src/common/data/content-hash.js';
import { createMockAuth } from '../fixtures/auth.js';
import { captureEvent } from '../fixtures/capture.js';
import { demoOrder, demoTracking, demoDelivery } from '../fixtures/commerce.js';
import { EvidenceStorage } from '../../src/modules/evidence/evidence-storage.js';
import { ApiException } from '../../src/common/http/api.exception.js';

describe('M03 orders ↔ M04 structured evidence (real PostgreSQL/HTTP, explicit DEMO commerce/JWKS)', () => {
  const merchantId = randomUUID();
  const otherMerchantId = randomUUID();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  const actor: MerchantActor = { merchantId, userId: adminId, role: 'ADMIN' };
  let context: Awaited<ReturnType<typeof createApp>>;
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let prisma: PrismaService;
  let orders: OrdersService;
  let transactions: TransactionsService;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('TEST_DATABASE_URL required');
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MERCHANT_ID: merchantId,
        SUPABASE_URL: issuer.origin,
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    orders = context.app.get(OrdersService);
    transactions = context.app.get(TransactionsService);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'DEMO / MOCK commerce tests',
        members: {
          create: [
            { authUserId: adminId, role: 'ADMIN' },
            { authUserId: viewerId, role: 'VIEWER' },
          ],
        },
      },
    });
    await prisma.merchant.create({
      data: { id: otherMerchantId, displayName: 'DEMO / MOCK other merchant' },
    });
    adminToken = await issuer.token(adminId);
    viewerToken = await issuer.token(viewerId);
  });
  afterAll(async () => {
    if (prisma) {
      const where = { merchantId: { in: [merchantId, otherMerchantId] } };
      await prisma.evidenceItem.deleteMany({ where: { dossier: where } });
      await prisma.evidenceDossier.deleteMany({ where });
      await prisma.transaction.deleteMany({ where });
      await prisma.merchantOrder.deleteMany({ where });
      await prisma.ingestionJob.deleteMany({ where: { event: where } });
      await prisma.webhookEvent.deleteMany({ where });
      await prisma.merchantMember.deleteMany({ where });
      await prisma.merchant.deleteMany({
        where: { id: { in: [merchantId, otherMerchantId] } },
      });
    }
    await context?.app.close();
    await issuer?.close();
  });
  const http = () => request(context.app.getHttpServer());
  const create = (body: CreateOrder) =>
    http().post('/api/orders').auth(adminToken, { type: 'bearer' }).send(body);
  const detail = (id: string) => transactions.detail(merchantId, id);
  async function queueCapture(
    reference: string,
    amount = '10.25',
    currency = 'USD',
  ) {
    const event = captureEvent(`CAP-${reference}`);
    event.resource.custom_id = `ORDER-${reference}`;
    event.resource.supplementary_data.related_ids.order_id = `PP-${reference}`;
    event.resource.amount = { value: amount, currency_code: currency };
    return prisma.webhookEvent.create({
      data: {
        merchantId,
        paypalEventId: event.id,
        eventType: event.event_type,
        eventCreatedAt: new Date(event.create_time),
        webhookId: 'MOCK-VERIFIED-FIXTURE',
        transmissionId: randomUUID(),
        payload: event,
        rawBody: JSON.stringify(event),
        payloadHash: contentHash(event),
        rawBodyHash: contentHash(event),
        job: { create: { kind: 'TRANSACTION_CAPTURED' } },
      },
    });
  }
  async function capture(
    reference: string,
    amount?: string,
    currency?: string,
  ) {
    await queueCapture(reference, amount, currency);
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    return prisma.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: `CAP-${reference}` },
    });
  }
  async function paired(reference: string) {
    await orders.create(actor, demoOrder(reference));
    return capture(reference);
  }

  it('stores and versions original files, authorizes downloads and detects tampering (MOCK Storage)', async () => {
    const storage = context.app.get(EvidenceStorage);
    const objects = new Map<string, Buffer>();
    const put = vi
      .spyOn(storage, 'put')
      .mockImplementation(async (key, bytes) => {
        objects.set(key, bytes);
      });
    const get = vi
      .spyOn(storage, 'get')
      .mockImplementation(async (key) => Buffer.from(objects.get(key)!));
    const privateBucket = vi
      .spyOn(storage, 'ensurePrivate')
      .mockResolvedValue();
    try {
      const row = await paired('FILES');
      const body = {
        sourceKind: 'DEMO',
        sourceSystem: 'DEMO / MOCK documents',
        externalReference: 'DEMO-PDF',
        retrievedAt: '2026-11-05T00:00:00Z',
        fileName: 'demo.pdf',
        mediaType: 'application/pdf',
        dataBase64: Buffer.from(
          '%PDF-1.7\nDEMO / MOCK original\n%%EOF',
        ).toString('base64'),
      };
      const url = `/api/transactions/${row.id}/evidence/files`;
      const upload = (input = body) =>
        http().post(url).auth(adminToken, { type: 'bearer' }).send(input);
      await http().post(url).send(body).expect(401);
      await http().get(`${url}/${randomUUID()}`).expect(401);
      await http()
        .post(url)
        .auth(viewerToken, { type: 'bearer' })
        .send(body)
        .expect(403);
      expect(put).not.toHaveBeenCalled();
      await upload({ ...body, fileName: '../bad.pdf' }).expect(400);
      await upload({ ...body, mediaType: 'image/png' }).expect(400);
      const oversized = Buffer.alloc(512 * 1024 + 1);
      oversized.write('%PDF-');
      await upload({
        ...body,
        dataBase64: oversized.toString('base64'),
      }).expect(400);
      const first = await upload().expect(201);
      expect(first.body.outcome).toBe('CREATED');
      const duplicate = await upload().expect(201);
      expect(duplicate.body).toEqual({ ...first.body, outcome: 'DUPLICATE' });
      const changed = await upload({
        ...body,
        dataBase64: Buffer.from('%PDF-1.7\nDEMO revision\n%%EOF').toString(
          'base64',
        ),
      }).expect(201);
      expect(changed.body.version).toBe(first.body.version + 1);
      const writes = put.mock.calls.length;
      await upload({ ...body, sourceKind: 'MERCHANT_INPUT' }).expect(409);
      await upload({ ...body, retrievedAt: '2026-11-04T00:00:00Z' }).expect(
        409,
      );
      expect(put).toHaveBeenCalledTimes(writes);
      const dossier = await transactions.dossier(merchantId, row.id);
      expect(dossier.items.filter((i) => i.type === 'DOCUMENT')).toHaveLength(
        2,
      );
      expect((await detail(row.id)).readiness.status).toBe('INCOMPLETE');
      const downloaded = await http()
        .get(`${url}/${first.body.evidenceId}`)
        .auth(viewerToken, { type: 'bearer' })
        .expect(200);
      expect(downloaded.headers['cache-control']).toBe('private, no-store');
      expect(downloaded.headers['content-disposition']).toBe(
        'attachment; filename="demo.pdf"',
      );
      expect(downloaded.body).toEqual(Buffer.from(body.dataBase64, 'base64'));
      await expect(
        transactions.downloadEvidenceFile(
          otherMerchantId,
          row.id,
          first.body.evidenceId,
        ),
      ).rejects.toThrow('Transaction not found');
      await expect(
        transactions.uploadEvidenceFile(
          { ...actor, merchantId: otherMerchantId },
          row.id,
          { ...body, sourceKind: 'DEMO', mediaType: 'application/pdf' },
        ),
      ).rejects.toThrow('Transaction not found');
      await http()
        .get(`${url}/${randomUUID()}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(404);
      const other = await paired('FILES-OTHER');
      await http()
        .get(
          `/api/transactions/${other.id}/evidence/files/${first.body.evidenceId}`,
        )
        .auth(adminToken, { type: 'bearer' })
        .expect(404);
      get.mockResolvedValueOnce(Buffer.from('MOCK tampered'));
      await http()
        .get(`${url}/${first.body.evidenceId}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(409);
      put.mockRejectedValueOnce(
        new ApiException('EVIDENCE_STORAGE_FAILED', 'MOCK Storage outage', 502),
      );
      const before = await prisma.evidenceItem.count();
      const revisionBefore = (await transactions.dossier(merchantId, row.id))
        .revision;
      await upload({ ...body, externalReference: 'DEMO-FAILED' }).expect(502);
      expect(await prisma.evidenceItem.count()).toBe(before);
      expect((await transactions.dossier(merchantId, row.id)).revision).toBe(
        revisionBefore,
      );
      const originalItem = await prisma.evidenceItem.findUniqueOrThrow({
        where: { id: changed.body.evidenceId },
      });
      await prisma.evidenceItem.update({
        where: { id: originalItem.id },
        data: { content: { ...body, fileName: 'tampered.pdf' } },
      });
      expect((await detail(row.id)).readiness).toMatchObject({
        status: 'NEEDS_REVIEW',
        reasons: ['EVIDENCE_FILE_METADATA_INVALID'],
      });
      const reads = get.mock.calls.length;
      await http()
        .get(`${url}/${originalItem.id}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(409);
      expect(get).toHaveBeenCalledTimes(reads);
      await prisma.evidenceItem.update({
        where: { id: originalItem.id },
        data: { content: originalItem.content! },
      });
    } finally {
      put.mockRestore();
      get.mockRestore();
      privateBucket.mockRestore();
    }
  });

  it('registers a sourced commercial order, links a later capture and persists original payment/order evidence', async () => {
    const created = await create(demoOrder('BEFORE')).expect(201);
    const receipt = OrderReceiptSchema.parse(created.body);
    expect(receipt.outcome).toBe('CREATED');
    expect(receipt.order.sourceKind).toBe('DEMO');
    expect(receipt.order).not.toHaveProperty('createdBy');
    const row = await capture('BEFORE');
    const result = await detail(row.id);
    expect(result.order?.id).toBe(receipt.order.id);
    expect(result.orderLink).toEqual({ status: 'LINKED', reason: null });
    expect(result.readiness).toMatchObject({
      status: 'INCOMPLETE',
      containsDemo: true,
      evidenceRevision: 2,
    });
    expect(
      result.readiness.checks.find((c) => c.code === 'ORDER_RECORD'),
    ).toMatchObject({ status: 'PRESENT', evidenceIds: [expect.any(String)] });
    const dossier = await http()
      .get(`/api/transactions/${row.id}/evidence`)
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    const parsed = EvidenceDossierResponseSchema.parse(dossier.body);
    expect(parsed.items.map((i) => i.type).sort()).toEqual([
      'ORDER_RECORD',
      'PAYMENT_RECORD',
    ]);
    expect(parsed.items.every((i) => i.integrity === 'VALID')).toBe(true);
  });

  it('links an earlier capture when the matching order arrives and refreshes existing dossiers idempotently', async () => {
    const row = await capture('AFTER');
    expect((await detail(row.id)).orderLink.status).toBe('UNLINKED');
    await create(demoOrder('AFTER')).expect(201);
    expect((await detail(row.id)).orderLink.status).toBe('LINKED');
    const before = await transactions.dossier(merchantId, row.id);
    const result = await http()
      .post(`/api/transactions/${row.id}/refresh-evidence`)
      .auth(adminToken, { type: 'bearer' })
      .expect(201);
    expect(result.body.readiness.evidenceRevision).toBe(before.revision);
  });

  it('does not miss concurrent arrival of an order and its capture', async () => {
    await queueCapture('RACE');
    await Promise.all([
      orders.create(actor, demoOrder('RACE')),
      transactions.processNextCapture(merchantId),
    ]);
    const row = await prisma.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: 'CAP-RACE' },
    });
    expect((await detail(row.id)).orderLink.status).toBe('LINKED');
  });

  it('deduplicates concurrent orders and refuses to overwrite their source data', async () => {
    const body = demoOrder('DUPLICATE');
    const receipts = await Promise.all([
      orders.create(actor, body),
      orders.create(actor, { ...body, totalAmount: '10.2500' }),
    ]);
    expect(receipts.map((r) => r.outcome).sort()).toEqual([
      'CREATED',
      'DUPLICATE',
    ]);
    await create({
      ...body,
      items: [{ ...body.items[0]!, description: 'DIFFERENT MOCK ITEM' }],
    }).expect(409);
    expect(
      await prisma.merchantOrder.count({
        where: { merchantId, externalId: body.externalId },
      }),
    ).toBe(1);
  });

  it.each([
    ['AMOUNT', '11.00', 'USD', 'ORDER_AMOUNT_MISMATCH'],
    ['CURRENCY', '10.25', 'EUR', 'ORDER_CURRENCY_MISMATCH'],
  ])(
    'retains the payment but blocks a mismatching order (%s)',
    async (ref, amount, currency, reason) => {
      await orders.create(actor, demoOrder(ref!));
      const row = await capture(ref!, amount, currency);
      const result = await detail(row.id);
      expect(result.order).toBeNull();
      expect(result.orderLink).toEqual({ status: 'CONFLICT', reason });
      expect(result.readiness.status).toBe('NEEDS_REVIEW');
    },
  );

  it('detects references that identify different orders, including after a previous linkage', async () => {
    // A new order claims the PayPal reference of a capture already linked by custom_id.
    const customOnly = {
      ...demoOrder('REF-CONFLICT'),
      paypalOrderId: undefined,
    };
    await orders.create(actor, customOnly);
    const conflictingRow = await capture('REF-CONFLICT');
    await orders.create(actor, {
      ...demoOrder('OTHER-REF'),
      paypalOrderId: 'PP-REF-CONFLICT',
    });
    expect((await detail(conflictingRow.id)).orderLink.reason).toBe(
      'ORDER_REFERENCE_CONFLICT',
    );
  });

  it('calculates order totals exactly, rejects unknown fields and restricts writes to ADMIN', async () => {
    await create({ ...demoOrder('BAD-TOTAL'), totalAmount: '11' }).expect(400);
    await http()
      .post('/api/orders')
      .auth(adminToken, { type: 'bearer' })
      .send({ ...demoOrder('EXTRA'), merchantId: otherMerchantId })
      .expect(400);
    await http()
      .post('/api/orders')
      .auth(viewerToken, { type: 'bearer' })
      .send(demoOrder('VIEWER'))
      .expect(403);
    const body = {
      ...demoOrder('DECIMALS'),
      totalAmount: '0.3',
      items: [
        { description: 'DEMO decimal item', quantity: 3, unitAmount: '0.1' },
      ],
    };
    const result = await create(body).expect(201);
    expect(result.body.order.totalAmount).toBe('0.3');
    const precise = {
      ...demoOrder('PRECISE'),
      totalAmount: '9999999999999999.12345678',
      items: [
        {
          description: 'DEMO exact decimal precision',
          quantity: 1,
          unitAmount: '9999999999999999.12345678',
        },
      ],
    };
    expect((await create(precise).expect(201)).body.order.totalAmount).toBe(
      precise.totalAmount,
    );
  });

  it('moves INCOMPLETE → READY from actual stored source records, with clear DEMO provenance', async () => {
    const row = await paired('READY');
    const shipment = await http()
      .post(`/api/transactions/${row.id}/evidence`)
      .auth(adminToken, { type: 'bearer' })
      .send(demoTracking('READY'))
      .expect(201);
    expect(shipment.body.transaction.readiness.status).toBe('INCOMPLETE');
    const delivered = await http()
      .post(`/api/transactions/${row.id}/evidence`)
      .auth(adminToken, { type: 'bearer' })
      .send(demoDelivery('READY'))
      .expect(201);
    expect(delivered.body.transaction.readiness).toMatchObject({
      status: 'READY',
      containsDemo: true,
      evidenceRevision: 4,
      basis: 'DOCUMENT_COVERAGE',
    });
    expect(
      delivered.body.transaction.readiness.checks.every(
        (c: { status: string }) => c.status === 'PRESENT',
      ),
    ).toBe(true);
    const list = await http()
      .get('/api/transactions?paypalCaptureId=CAP-READY')
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    expect(list.body.items[0].readiness.status).toBe('READY');
  });

  it('preserves history and regresses readiness when delivery is retracted', async () => {
    const row = await paired('VERSIONS');
    await transactions.registerEvidence(
      actor,
      row.id,
      demoTracking('VERSIONS'),
    );
    const original = demoDelivery('VERSIONS');
    const first = await transactions.registerEvidence(actor, row.id, original);
    const duplicate = await transactions.registerEvidence(
      actor,
      row.id,
      original,
    );
    expect(duplicate.outcome).toBe('DUPLICATE');
    expect(duplicate.evidenceId).toBe(first.evidenceId);
    if (original.type !== 'PROOF_OF_DELIVERY')
      throw new Error('Invalid fixture');
    const revoked = await transactions.registerEvidence(actor, row.id, {
      ...original,
      content: { ...original.content, status: 'RETRACTED' },
    });
    expect(revoked.transaction.readiness.status).toBe('INCOMPLETE');
    const dossier = await transactions.dossier(merchantId, row.id);
    expect(dossier.revision).toBe(5);
    expect(
      dossier.items.filter((i) => i.type === 'PROOF_OF_DELIVERY'),
    ).toHaveLength(2);
    expect(dossier.items.find((i) => i.id === first.evidenceId)?.current).toBe(
      false,
    );
    expect(
      dossier.items.find((i) => i.id === revoked.evidenceId)?.current,
    ).toBe(true);
  });

  it('blocks contradictory tracking and delivery dates without losing the originals', async () => {
    const row = await paired('CONTRADICTION');
    await transactions.registerEvidence(
      actor,
      row.id,
      demoTracking('CONTRADICTION'),
    );
    const proof = demoDelivery('CONTRADICTION');
    const result = await transactions.registerEvidence(actor, row.id, {
      ...proof,
      content: { ...proof.content, trackingNumber: 'MOCK-OTHER-PARCEL' },
    });
    expect(result.transaction.readiness.status).toBe('NEEDS_REVIEW');
    expect(result.transaction.readiness.reasons).toContain(
      'TRACKING_CONTRADICTION',
    );
    if (proof.type !== 'PROOF_OF_DELIVERY') throw new Error('Invalid fixture');
    const early = await transactions.registerEvidence(actor, row.id, {
      ...proof,
      content: { ...proof.content, deliveredAt: '2026-11-06T00:30:00Z' },
    });
    expect(early.transaction.readiness.reasons).toContain(
      'DELIVERY_BEFORE_SHIPMENT',
    );
  });

  it('rejects evidence for another payment/order, future dates and client-supplied PayPal evidence', async () => {
    const row = await paired('IDENTITY');
    const shipment = demoTracking('IDENTITY');
    await http()
      .post(`/api/transactions/${row.id}/evidence`)
      .auth(adminToken, { type: 'bearer' })
      .send({
        ...shipment,
        content: { ...shipment.content, merchantOrderReference: 'ORDER-OTHER' },
      })
      .expect(409);
    await http()
      .post(`/api/transactions/${row.id}/evidence`)
      .auth(adminToken, { type: 'bearer' })
      .send({ ...shipment, retrievedAt: '2099-01-01T00:00:00Z' })
      .expect(400);
    await http()
      .post(`/api/transactions/${row.id}/evidence`)
      .auth(adminToken, { type: 'bearer' })
      .send({ ...shipment, sourceKind: 'PAYPAL' })
      .expect(400);
    await http()
      .post(`/api/transactions/${row.id}/evidence`)
      .auth(viewerToken, { type: 'bearer' })
      .send(shipment)
      .expect(403);
    await http()
      .post(`/api/transactions/${row.id}/refresh-evidence`)
      .auth(viewerToken, { type: 'bearer' })
      .expect(403);
    expect((await transactions.dossier(merchantId, row.id)).revision).toBe(2);
  });

  it('does not relabel DEMO evidence as real and serializes concurrent versions', async () => {
    const row = await paired('CONCURRENT-EVIDENCE');
    const shipment = demoTracking('CONCURRENT-EVIDENCE');
    const results = await Promise.all([
      transactions.registerEvidence(actor, row.id, shipment),
      transactions.registerEvidence(actor, row.id, shipment),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual([
      'CREATED',
      'DUPLICATE',
    ]);
    await expect(
      transactions.registerEvidence(actor, row.id, {
        ...shipment,
        sourceKind: 'MERCHANT_INPUT',
      }),
    ).rejects.toThrow('Evidence provenance cannot be relabeled');
    expect((await transactions.dossier(merchantId, row.id)).revision).toBe(3);
  });

  it('detects a changed stored original through its hash', async () => {
    const row = await paired('INTEGRITY');
    const receipt = await transactions.registerEvidence(
      actor,
      row.id,
      demoTracking('INTEGRITY'),
    );
    await prisma.evidenceItem.update({
      where: { id: receipt.evidenceId },
      data: { content: { unexpected: 'DEMO / MOCK TAMPERING' } },
    });
    const result = await detail(row.id);
    expect(result.readiness.status).toBe('NEEDS_REVIEW');
    expect(result.readiness.reasons).toContain('EVIDENCE_INTEGRITY_MISMATCH');
    expect(
      (await transactions.dossier(merchantId, row.id)).items.find(
        (i) => i.id === receipt.evidenceId,
      )?.integrity,
    ).toBe('INVALID');
  });

  it('does not let a stale delivery record supersede a later retraction', async () => {
    const row = await paired('STALE');
    await transactions.registerEvidence(actor, row.id, demoTracking('STALE'));
    const proof = demoDelivery('STALE');
    await transactions.registerEvidence(actor, row.id, proof);
    await transactions.registerEvidence(actor, row.id, {
      ...proof,
      retrievedAt: '2026-11-06T04:00:00Z',
      content: { ...proof.content, status: 'RETRACTED' },
    });
    await expect(
      transactions.registerEvidence(actor, row.id, proof),
    ).rejects.toThrow('Older evidence cannot replace a newer source record');
    expect((await detail(row.id)).readiness.status).toBe('INCOMPLETE');
    expect((await transactions.dossier(merchantId, row.id)).revision).toBe(5);
  });

  it('blocks cancelled shipments and tampered commercial orders', async () => {
    const row = await paired('CANCELLED');
    const shipment = demoTracking('CANCELLED');
    await transactions.registerEvidence(actor, row.id, {
      ...shipment,
      content: { ...shipment.content, status: 'CANCELLED' },
    });
    const cancelled = await detail(row.id);
    expect(cancelled.readiness.reasons).toContain('SHIPMENT_CANCELLED');
    expect(cancelled.readiness.status).toBe('NEEDS_REVIEW');
    await prisma.merchantOrder.update({
      where: { id: cancelled.order!.id },
      data: { totalAmount: '999' },
    });
    expect((await detail(row.id)).readiness.reasons).toContain(
      'ORDER_INTEGRITY_MISMATCH',
    );
  });

  it('supports merchant-supplied originals without labeling them as independently verified', async () => {
    const order = demoOrder('MERCHANT-SUPPLIED');
    await orders.create(actor, {
      ...order,
      sourceKind: 'MERCHANT_INPUT',
      sourceSystem: 'merchant-api',
    });
    const row = await capture('MERCHANT-SUPPLIED');
    await transactions.registerEvidence(actor, row.id, {
      ...demoTracking('MERCHANT-SUPPLIED'),
      sourceKind: 'MERCHANT_INPUT',
      sourceSystem: 'merchant-api',
    });
    const result = await transactions.registerEvidence(actor, row.id, {
      ...demoDelivery('MERCHANT-SUPPLIED'),
      sourceKind: 'MERCHANT_INPUT',
      sourceSystem: 'merchant-api',
    });
    expect(result.transaction.readiness).toMatchObject({
      status: 'READY',
      containsDemo: false,
      basis: 'DOCUMENT_COVERAGE',
    });
    const dossier = await transactions.dossier(merchantId, row.id);
    expect(
      dossier.items.every((item) =>
        ['PAYPAL', 'MERCHANT_INPUT'].includes(item.sourceKind),
      ),
    ).toBe(true);
    expect(dossier.items.every((item) => !('verified' in item))).toBe(true);
  });

  it('initializes a legacy capture dossier via an authorized refresh without making GET write data', async () => {
    const row = await capture('LEGACY');
    await prisma.evidenceItem.deleteMany({
      where: { dossier: { transactionId: row.id } },
    });
    await prisma.evidenceDossier.delete({ where: { transactionId: row.id } });
    expect((await detail(row.id)).readiness.dossierId).toBeNull();
    await http()
      .get(`/api/transactions/${row.id}/evidence`)
      .auth(viewerToken, { type: 'bearer' })
      .expect(404);
    const refreshed = await http()
      .post(`/api/transactions/${row.id}/refresh-evidence`)
      .auth(adminToken, { type: 'bearer' })
      .expect(201);
    expect(refreshed.body.readiness.evidenceRevision).toBe(1);
    expect(refreshed.body.readiness.dossierId).toEqual(expect.any(String));
  });

  it('rolls back the ingestion job, payment and dossier together if M04 persistence fails', async () => {
    const queued = await queueCapture('VAULT-ROLLBACK');
    const before = await prisma.evidenceDossier.count({
      where: { merchantId },
    });
    const evidence = context.app.get(EvidenceService);
    const original = evidence.syncBase.bind(evidence);
    const failure = vi
      .spyOn(evidence, 'syncBase')
      .mockImplementationOnce(async (tx, ctx) => {
        await original(tx, ctx);
        throw new Error('MOCK_EVIDENCE_PERSISTENCE_FAILURE');
      });
    try {
      await expect(transactions.processNextCapture(merchantId)).rejects.toThrow(
        'MOCK_EVIDENCE_PERSISTENCE_FAILURE',
      );
    } finally {
      failure.mockRestore();
    }
    expect(
      await prisma.transaction.count({
        where: { merchantId, paypalCaptureId: 'CAP-VAULT-ROLLBACK' },
      }),
    ).toBe(0);
    expect(await prisma.evidenceDossier.count({ where: { merchantId } })).toBe(
      before,
    );
    expect(
      await prisma.ingestionJob.findUnique({ where: { eventId: queued.id } }),
    ).toMatchObject({ status: 'QUEUED' });
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
  });

  it('keeps orders and dossiers merchant-scoped, including their foreign keys', async () => {
    const row = await paired('TENANT');
    const linked = await detail(row.id);
    await expect(
      orders.detail(otherMerchantId, linked.order!.id),
    ).rejects.toThrow('Order not found');
    expect(
      (await orders.list(otherMerchantId, { page: 1, pageSize: 20 })).total,
    ).toBe(0);
    await expect(transactions.dossier(otherMerchantId, row.id)).rejects.toThrow(
      'Transaction not found',
    );
    await expect(
      transactions.refreshEvidence(
        { ...actor, merchantId: otherMerchantId },
        row.id,
      ),
    ).rejects.toThrow('Transaction not found');
    await expect(
      prisma.evidenceDossier.create({
        data: { merchantId: otherMerchantId, transactionId: row.id },
      }),
    ).rejects.toThrow();
    await http()
      .get(`/api/orders/${linked.order!.id}`)
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    const page = await http()
      .get('/api/orders?externalId=ORDER-TENANT&pageSize=1')
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    expect(page.body.total).toBe(1);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE pg_read_all_data`;
      expect(await tx.$queryRaw`SELECT id FROM merchant_orders`).toEqual([]);
      expect(await tx.$queryRaw`SELECT id FROM evidence_dossiers`).toEqual([]);
      expect(await tx.$queryRaw`SELECT id FROM evidence_items`).toEqual([]);
    });
  });
});
