import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { contentHash } from '../../src/common/data/content-hash.js';
import { encryptErpSecret } from '../../src/common/crypto/secret-box.js';
import { TransactionsService } from '../../src/modules/transactions/index.js';
import { OrderSourcesService } from '../../src/modules/transactions/sources/order-sources.service.js';
import { IntegrationsService } from '../../src/modules/integrations/integrations.service.js';
import { EvidenceStorage } from '../../src/modules/evidence/evidence-storage.js';
import { createMockAuth } from '../fixtures/auth.js';
import { captureEvent } from '../fixtures/capture.js';
import { mockTransmissionHeaders } from '../fixtures/paypal-webhook.js';

describe('Odoo → M03 → M04 associations (real PostgreSQL/HTTP, MOCK Odoo/PayPal/Auth/Storage)', () => {
  const merchantId = randomUUID(),
    otherTeam = randomUUID(),
    userId = randomUUID();
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  let context: Awaited<ReturnType<typeof createApp>>,
    issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let prisma: PrismaService,
    transactions: TransactionsService,
    sources: OrderSourcesService,
    integrations: IntegrationsService;
  let connectionId: string, token: string;
  const objects = new Map<string, Buffer>();
  const writeDate = '2026-11-06 00:00:00';
  const sale = {
    id: 1,
    name: 'S0001',
    partner_id: [2, 'MOCK customer'],
    date_order: '2026-11-05 12:00:00',
    amount_total: 10.25,
    currency_id: [1, 'USD'],
    invoice_ids: [11],
    client_order_ref: false,
    company_id: [1, 'MOCK company'],
    amount_tax: 0,
    amount_untaxed: 10.25,
    write_date: writeDate,
  };
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('Disposable TEST_DATABASE_URL required');
    issuer = await createMockAuth();
    const native = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://api-m.sandbox.paypal.com/')) {
        if (url.endsWith('/oauth2/token'))
          return Response.json({
            access_token: 'MOCK',
            token_type: 'Bearer',
            expires_in: 300,
          });
        if (url.endsWith('/verify-webhook-signature'))
          return Response.json({ verification_status: 'SUCCESS' });
        throw new Error('Unexpected MOCK PayPal request');
      }
      if (!url.startsWith('https://demo.odoo.com/json/2/'))
        return native(input, init);
      const path = new URL(url).pathname;
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'bearer MOCK-ODOO-KEY',
      );
      if (path.endsWith('/sale.order/search_read'))
        return Response.json([sale]);
      if (path.endsWith('/sale.order.line/search_read'))
        return Response.json([
          {
            id: 10,
            order_id: [1, 'S0001'],
            name: 'MOCK item',
            product_uom_qty: 1,
            price_unit: 10.25,
            discount: 0,
          },
        ]);
      if (path.endsWith('/account.move/search_read'))
        return Response.json([
          {
            id: 11,
            name: 'INV/11',
            partner_id: [2, 'MOCK customer'],
            invoice_date: '2026-11-05',
            amount_total: 10.25,
            currency_id: [1, 'USD'],
            payment_reference: 'INV/11',
            invoice_payment_term_id: false,
            invoice_origin: 'S0001',
            company_id: [1, 'MOCK company'],
            write_date: writeDate,
          },
        ]);
      if (path.endsWith('/account.payment/search_read'))
        return Response.json([
          {
            id: 21,
            name: 'PAY/21',
            partner_id: [2, 'MOCK customer'],
            date: '2026-11-05',
            amount: 10.25,
            currency_id: [1, 'USD'],
            memo: 'INV/11',
            write_date: writeDate,
          },
        ]);
      if (path.endsWith('/stock.picking/search_read'))
        return Response.json([
          {
            id: 31,
            name: 'OUT/31',
            partner_id: [2, 'MOCK customer'],
            scheduled_date: '2026-11-06 00:00:00',
            date_done: '2026-11-06 01:00:00',
            origin: 'S0001',
            move_ids: [1],
            company_id: [1, 'MOCK company'],
            write_date: writeDate,
          },
        ]);
      const attachment = {
        id: 100,
        name: 'MOCK-invoice.png',
        mimetype: 'image/png',
        file_size: image.length,
        res_model: 'account.move',
        res_id: 11,
        write_date: writeDate,
      };
      if (path.endsWith('/ir.attachment/search_read'))
        return Response.json([attachment]);
      if (path.endsWith('/ir.attachment/read'))
        return Response.json([
          { ...attachment, datas: image.toString('base64') },
        ]);
      throw new Error('Unexpected MOCK Odoo request');
    });
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        SUPABASE_URL: issuer.origin,
        MERCHANT_ID: merchantId,
        PAYPAL_CLIENT_ID: 'MOCK',
        PAYPAL_CLIENT_SECRET: 'MOCK',
        PAYPAL_WEBHOOK_ID: 'MOCK',
        MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    transactions = context.app.get(TransactionsService);
    sources = context.app.get(OrderSourcesService);
    integrations = context.app.get(IntegrationsService);
    for (const id of [merchantId, otherTeam])
      await prisma.merchant.create({
        data: {
          id,
          displayName: 'MOCK Odoo association',
          ...(id === merchantId
            ? { members: { create: { authUserId: userId, role: 'ADMIN' } } }
            : {}),
        },
      });
    token = await issuer.token(userId);
    connectionId = await connect(merchantId);
    const storage = context.app.get(EvidenceStorage);
    vi.spyOn(storage, 'put').mockImplementation(async (key, bytes) => {
      objects.set(key, Buffer.from(bytes));
    });
    vi.spyOn(storage, 'get').mockImplementation(async (key) =>
      Buffer.from(objects.get(key)!),
    );
    vi.spyOn(storage, 'ensurePrivate').mockResolvedValue();
    for (const resource of [
      'sales_orders',
      'invoices',
      'payments',
      'shipments',
    ])
      await integrations.processErpSync({
        connectionId,
        merchantId,
        provider: 'odoo',
        resource,
        cursor: null,
      });
  });
  afterAll(async () => {
    await context?.app.close();
    await issuer?.close();
    vi.restoreAllMocks();
  });
  async function connect(team: string) {
    const connection = await prisma.erpConnection.create({
      data: {
        merchantId: team,
        provider: 'odoo',
        status: 'connected',
        baseUrl: 'https://demo.odoo.com',
      },
    });
    await prisma.erpSecret.create({
      data: {
        connectionId: connection.id,
        encryptedPayload: await encryptErpSecret(
          {
            apiKey: 'MOCK-ODOO-KEY',
            database: 'demo',
            baseUrl: 'https://demo.odoo.com',
          },
          context.environment,
        ),
      },
    });
    return connection.id;
  }
  async function capture(reference: string) {
    const event = captureEvent(`MOCK-${randomUUID()}`);
    const receipt = await request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send({
        ...event,
        resource: {
          ...event.resource,
          custom_id: reference,
          supplementary_data: undefined,
        },
      })
      .expect(200);
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    return prisma.transaction.findUniqueOrThrow({
      where: { sourceEventId: receipt.body.eventId },
    });
  }
  async function putRecord(
    connection: string,
    team: string,
    type: string,
    id: string,
    payload: Record<string, unknown>,
  ) {
    return prisma.externalRecord.create({
      data: {
        merchantId: team,
        connectionId: connection,
        recordType: type,
        externalId: id,
        updatedAt: new Date(),
        normalizedPayload: payload as never,
        sourceHash: contentHash(payload),
      },
    });
  }
  const orderPayload = (reference: string) => ({
    orderNumber: reference,
    currency: 'USD',
    amount: '10.25',
    orderedAt: '2026-11-05 12:00:00',
    items: [{ description: 'MOCK item', quantity: '1', unitAmount: '10.25' }],
  });

  it('associates the order, its invoice, payment and shipment and preserves the exact original attachment', async () => {
    const row = await capture('S0001');
    expect(await sources.processNext(merchantId, row.id)).toBe('PROCESSED');
    const detail = await transactions.detail(merchantId, row.id);
    const source = detail.orderEnrichment.records.find(
      (r) => r.providerId === 'ODOO',
    )!;
    expect(source.data).toMatchObject({
      association: 'MATCHED',
      issues: [],
      documentImport: { status: 'IMPORTED', count: 1 },
    });
    expect(
      source.data?.relatedRecords?.map((r) => r.recordType).sort(),
    ).toEqual(['invoice', 'payment', 'sales_order', 'shipment']);
    expect(
      source.data?.relatedRecords?.find((r) => r.recordType === 'invoice')
        ?.matchMethod,
    ).toBe('odoo_relation_exact');
    expect(detail.order).toMatchObject({
      sourceKind: 'CONNECTED_SYSTEM',
      invoiceId: 'INV/11',
      items: [{ description: 'MOCK item', quantity: 1, unitAmount: '10.25' }],
    });
    const sparsePayPal = {
      ...source.data!,
      order: {
        ...source.data!.order!,
        providerId: 'PAYPAL',
        sourceKind: 'PAYPAL',
        sourceSystem: 'paypal-sandbox',
        items: [],
      },
      missingFields: ['ORDER_ITEMS'],
      relatedRecords: undefined,
      documentImport: undefined,
    };
    const paypalJob = await prisma.orderSourceJob.create({
      data: {
        merchantId,
        transactionId: row.id,
        providerId: 'PAYPAL',
        sourceKind: 'PAYPAL',
        sourceSystem: 'paypal-sandbox',
        status: 'PARTIAL',
        normalized: JSON.parse(JSON.stringify(sparsePayPal)),
        contentHash: contentHash(sparsePayPal),
      },
    });
    try {
      expect(
        (await transactions.detail(merchantId, row.id)).order,
      ).toMatchObject({ providerId: 'ODOO' });
    } finally {
      await prisma.orderSourceJob.delete({ where: { id: paypalJob.id } });
    }
    expect(
      detail.readiness.checks.find((c) => c.code === 'ORDER_RECORD')?.status,
    ).toBe('PRESENT');
    expect(
      detail.readiness.checks.find((c) => c.code === 'PROOF_OF_DELIVERY')
        ?.status,
    ).toBe('MISSING');
    const links = await integrations.getLinkedRecords(
      merchantId,
      row.paypalCaptureId,
    );
    expect(links.total).toBe(4);
    const dossier = await transactions.dossier(merchantId, row.id);
    expect(dossier.items.every((i) => i.integrity === 'VALID')).toBe(true);
    const file = dossier.items.find((i) => i.type === 'DOCUMENT')!;
    expect(file.sourceKind).toBe('CONNECTED_SYSTEM');
    const download = await request(context.app.getHttpServer())
      .get(`/api/transactions/${row.id}/evidence/files/${file.id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(download.body).toEqual(image);
    await sources.refresh(merchantId, row.id);
    expect((await transactions.dossier(merchantId, row.id)).revision).toBe(
      dossier.revision,
    );
    expect(
      (await integrations.getLinkedRecords(merchantId, row.paypalCaptureId))
        .total,
    ).toBe(4);
    await request(context.app.getHttpServer())
      .post(`/api/transactions/${row.id}/evidence/files`)
      .auth(token, { type: 'bearer' })
      .send({
        sourceKind: 'CONNECTED_SYSTEM',
        sourceSystem: 'odoo',
        externalReference: 'FORGED',
        retrievedAt: new Date().toISOString(),
        fileName: 'forged.png',
        mediaType: 'image/png',
        dataBase64: image.toString('base64'),
      })
      .expect(400);
    await request(context.app.getHttpServer())
      .get(`/api/transactions/${row.id}`)
      .auth(token, { type: 'bearer' })
      .set('X-Merchant-Id', otherTeam)
      .expect(403);
  });

  it('does not associate by equal amount or customer and never uses another team records', async () => {
    const foreign = await connect(otherTeam);
    await putRecord(
      foreign,
      otherTeam,
      'sales_order',
      '45',
      orderPayload('FOREIGN-ONLY'),
    );
    const row = await capture('FOREIGN-ONLY');
    expect(await sources.processNext(merchantId, row.id)).toBe('PROCESSED');
    expect((await transactions.detail(merchantId, row.id)).order).toBeNull();
    expect(
      (await integrations.getLinkedRecords(merchantId, row.paypalCaptureId))
        .total,
    ).toBe(0);
  });

  it('blocks ambiguous orders across connections and explicit amount conflicts', async () => {
    const second = await connect(merchantId);
    await putRecord(
      connectionId,
      merchantId,
      'sales_order',
      '50',
      orderPayload('AMBIGUOUS'),
    );
    await putRecord(
      second,
      merchantId,
      'sales_order',
      '50',
      orderPayload('AMBIGUOUS'),
    );
    const ambiguous = await capture('AMBIGUOUS');
    await sources.processNext(merchantId, ambiguous.id);
    expect(
      (await transactions.detail(merchantId, ambiguous.id)).orderEnrichment
        .records[0]?.data?.issues,
    ).toContain('ODOO_AMBIGUOUS_CONNECTION');
    expect(
      (
        await integrations.getLinkedRecords(
          merchantId,
          ambiguous.paypalCaptureId,
        )
      ).total,
    ).toBe(0);
    await putRecord(connectionId, merchantId, 'sales_order', '51', {
      ...orderPayload('WRONG-AMOUNT'),
      amount: '99',
    });
    const mismatch = await capture('WRONG-AMOUNT');
    await sources.processNext(merchantId, mismatch.id);
    expect(
      (await transactions.detail(merchantId, mismatch.id)).readiness.status,
    ).toBe('NEEDS_REVIEW');
    expect(
      (
        await integrations.getLinkedRecords(
          merchantId,
          mismatch.paypalCaptureId,
        )
      ).total,
    ).toBe(0);
  });

  it('detects imported record tampering and never confirms a link', async () => {
    const record = await putRecord(
      connectionId,
      merchantId,
      'sales_order',
      '52',
      orderPayload('TAMPERED'),
    );
    await prisma.externalRecord.update({
      where: { id: record.id },
      data: { sourceHash: '0'.repeat(64) },
    });
    const row = await capture('TAMPERED');
    expect(await sources.processNext(merchantId, row.id)).toBe('FAILED');
    expect(
      (await integrations.getLinkedRecords(merchantId, row.paypalCaptureId))
        .total,
    ).toBe(0);
    expect(
      (
        await prisma.orderSourceJob.findUniqueOrThrow({
          where: {
            transactionId_providerId: {
              transactionId: row.id,
              providerId: 'ODOO',
            },
          },
        })
      ).errorCode,
    ).toBe('ODOO_RECORD_INTEGRITY_MISMATCH');
  });

  it('rolls back links, metadata and the new dossier revision when Storage fails, then recovers', async () => {
    const row = await capture('S0001');
    const before = await transactions.dossier(merchantId, row.id);
    vi.mocked(context.app.get(EvidenceStorage).put).mockRejectedValueOnce(
      new Error('MOCK_STORAGE_UNAVAILABLE'),
    );
    expect(await sources.processNext(merchantId, row.id)).toBe('FAILED');
    expect(
      (await integrations.getLinkedRecords(merchantId, row.paypalCaptureId))
        .total,
    ).toBe(0);
    expect((await transactions.dossier(merchantId, row.id)).revision).toBe(
      before.revision,
    );
    await sources.refresh(merchantId, row.id);
    expect(
      (await integrations.getLinkedRecords(merchantId, row.paypalCaptureId))
        .total,
    ).toBe(4);
  });

  it('backfills existing captures and rechecks imported data on the polling schedule', async () => {
    const row = await capture('LATE-IMPORT');
    await sources.processNext(merchantId, row.id);
    expect((await transactions.detail(merchantId, row.id)).order).toBeNull();
    await putRecord(
      connectionId,
      merchantId,
      'sales_order',
      '53',
      orderPayload('LATE-IMPORT'),
    );
    await prisma.orderSourceJob.delete({
      where: {
        transactionId_providerId: { transactionId: row.id, providerId: 'ODOO' },
      },
    });
    await sources.backfillPollingSources(merchantId);
    expect(await sources.processNext(merchantId, row.id)).toBe('PROCESSED');
    expect(
      (await integrations.getLinkedRecords(merchantId, row.paypalCaptureId))
        .total,
    ).toBe(1);
    const job = await prisma.orderSourceJob.findUniqueOrThrow({
      where: {
        transactionId_providerId: { transactionId: row.id, providerId: 'ODOO' },
      },
    });
    expect(job.nextAttemptAt).toBeInstanceOf(Date);
    expect(await sources.processNext(merchantId, row.id)).toBe('EMPTY');
    await prisma.orderSourceJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(0) },
    });
    expect(await sources.processNext(merchantId, row.id)).toBe('PROCESSED');
  });

  it('disconnects an instance with linked records and retains historical evidence', async () => {
    const linked = await prisma.transactionLink.findFirstOrThrow({
      where: { merchantId, record: { connectionId } },
    });
    const row = await prisma.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: linked.paypalCaptureId },
    });
    const before = await transactions.dossier(merchantId, row.id);
    await integrations.disconnect(merchantId, connectionId);
    await sources.refresh(merchantId, row.id);
    expect(
      (await integrations.getLinkedRecords(merchantId, row.paypalCaptureId))
        .total,
    ).toBe(0);
    expect(
      (await transactions.dossier(merchantId, row.id)).items.some((i) =>
        before.items.some((old) => old.id === i.id),
      ),
    ).toBe(true);
    expect((await transactions.detail(merchantId, row.id)).order).toBeNull();
  });
});
