import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { MEDIATION_NOTICE, type MediationPolicy } from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { MediationService } from '../../src/modules/mediation/mediation.service.js';
import {
  TransactionsService,
  OrdersService,
} from '../../src/modules/transactions/index.js';
import { DisputesService } from '../../src/modules/disputes/index.js';
import { AgentProvider } from '../../src/modules/investigator/index.js';
import { createMockAuth } from '../fixtures/auth.js';
import { captureEvent } from '../fixtures/capture.js';
import { disputeEvent } from '../fixtures/dispute.js';
import { mockTransmissionHeaders } from '../fixtures/paypal-webhook.js';
import { demoOrder } from '../fixtures/commerce.js';
import { EvidenceStorage } from '../../src/modules/evidence/evidence-storage.js';
import { dossierPdf } from '../../src/modules/mediation/dossier-pdf.js';
import {
  ENVIRONMENT,
  type Environment,
} from '../../src/common/config/environment.js';

describe('mediation: real Nest/PostgreSQL with MOCK LLM, PayPal and JWKS', () => {
  const merchantId = randomUUID(),
    userId = randomUUID(),
    viewerId = randomUUID();
  const actor = { merchantId, userId, role: 'ADMIN' as const };
  const policy: MediationPolicy = {
    enabled: true,
    conciliationDays: 3,
    claimHours: 24,
    evidenceHours: 24,
    deadlineMarginHours: 24,
    returns: 'Reposición con evidencia de defecto.',
    warranty: 'Garantía de fabricación.',
    businessDeadlines: 'Envío en cinco días.',
    allowedSolutions: ['REPLACEMENT', 'RESHIPMENT'],
    automaticSubmission: true,
  };
  let context: Awaited<ReturnType<typeof createApp>>,
    prisma: PrismaService,
    mediation: MediationService,
    token: string,
    viewerToken: string,
    issuer: Awaited<ReturnType<typeof createMockAuth>>;
  const details = new Map<string, Record<string, unknown>>();
  const writes: { url: string; body: unknown }[] = [];
  let detectionConfidence = 0.99,
    complaint = true,
    aiFailure = false,
    paypalTimeout = false;
  const verdictHuman = false;
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('TEST_DATABASE_URL required');
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api-m.sandbox.paypal.com/'))
        return nativeFetch(input, init);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({
          access_token: 'MOCK_TOKEN',
          token_type: 'Bearer',
          expires_in: 300,
        });
      if (url.endsWith('/v1/notifications/verify-webhook-signature'))
        return Response.json({ verification_status: 'SUCCESS' });
      if (/\/documents\//.test(url))
        return new Response(
          new Uint8Array(
            dossierPdf({ buyerStatement: 'MOCK original supplied by buyer' }),
          ),
          { headers: { 'content-type': 'application/pdf' } },
        );
      const match =
        /\/v1\/customer\/disputes\/([^/]+)(?:\/(send-message|provide-evidence|escalate|provide-supporting-info))?$/.exec(
          url,
        );
      if (!match) throw new Error(`Forbidden financial endpoint: ${url}`);
      const detail = details.get(match[1]!);
      if (!detail) return Response.json({}, { status: 404 });
      if (!match[2]) return Response.json(detail);
      writes.push({ url, body: init?.body });
      if (paypalTimeout) throw new Error('MOCK ambiguous timeout');
      if (match[2] === 'send-message') {
        const body = JSON.parse(String(init?.body));
        (detail.messages as unknown[]).push({
          posted_by: 'SELLER',
          time_posted: new Date().toISOString(),
          content: body.message,
        });
      }
      if (match[2] === 'escalate')
        detail.dispute_life_cycle_stage = 'CHARGEBACK';
      return Response.json({ links: [] });
    });
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MERCHANT_ID: merchantId,
        SUPABASE_URL: issuer.origin,
        PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
        PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
        PAYPAL_WEBHOOK_ID: 'MOCK_WEBHOOK',
        NVIDIA_API_KEY: 'MOCK_AI',
        MEDIATION_DETECTION_PER_MINUTE: '100',
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    mediation = context.app.get(MediationService);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'MOCK mediation',
        allowInvestigations: true,
        allowSubmissions: true,
        members: {
          create: [
            { authUserId: userId, role: 'ADMIN' },
            { authUserId: viewerId, role: 'VIEWER' },
          ],
        },
      },
    });
    token = await issuer.token(userId);
    viewerToken = await issuer.token(viewerId);
    vi.spyOn(
      context.app.get(AgentProvider),
      'structuredStep',
    ).mockImplementation(async (messages, _signal, schema) => {
      if (aiFailure) throw new Error('MOCK provider failure');
      const prompt = messages[0]!.text,
        data = JSON.parse(messages[1]!.text);
      let command: unknown;
      if (prompt.includes('Agente 1'))
        command = {
          complaint,
          type: 'SHIPPING_ERROR',
          severity: 'MEDIUM',
          summary: 'El comprador reporta que no recibió su pedido.',
          confidence: detectionConfidence,
          humanReview: false,
        };
      else if (prompt.includes('Agente 2'))
        command = {
          options: [
            {
              solution: 'RESHIPMENT',
              description:
                'Se propone reenvío voluntario sujeto a la política.',
            },
          ],
          summary: 'Propuesta registrada.',
          notice: MEDIATION_NOTICE,
          humanReview: false,
        };
      else {
        const ids = [
          ...data.evidence.map((e: { id: string }) => e.id),
          ...data.data.messages.map((e: { id: string }) => e.id),
          ...data.data.paypalEvidence.map((e: { id: string }) => e.id),
          ...(data.data.paypalFiles ?? []).map((e: { id: string }) => e.id),
        ];
        if (prompt.includes('Agente 3'))
          command = {
            recommendation: 'SELLER',
            evidenceBalance: 'EQUIVALENT',
            summary: 'Evidencia equivalente en el ejemplo MOCK.',
            grounds: [
              {
                statement: 'La identidad de la orden está documentada.',
                evidenceIds: [ids[0]],
              },
            ],
            assessedEvidence: ids.map((id) => ({
              evidenceId: id,
              assessment: 'Original considerado en el ejemplo MOCK.',
            })),
            notice: MEDIATION_NOTICE,
            humanReview: verdictHuman,
          };
        else
          command = {
            approved: true,
            reasons: ['Revisión independiente MOCK.'],
            evidenceIds: ids,
          };
      }
      return {
        command: schema.parse(command),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    await mediation.configure(actor, policy);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await context?.app.close();
    await issuer?.close();
  });
  const http = () => request(context.app.getHttpServer());
  async function seed() {
    const ref = randomUUID(),
      captureId = `CAP-${ref}`,
      paypalDisputeId = `PP-D-${ref}`;
    await context.app
      .get(OrdersService)
      .create(actor, { ...demoOrder(ref), sourceKind: 'MERCHANT_INPUT' });
    const capture = captureEvent(captureId);
    capture.resource.custom_id = `ORDER-${ref}`;
    capture.resource.supplementary_data.related_ids.order_id = `PP-${ref}`;
    await http()
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(capture)
      .expect(200);
    await context.app.get(TransactionsService).processNextCapture(merchantId);
    const openedAt = new Date(Date.now() - 3600000).toISOString(),
      due = new Date(Date.now() + 10 * 86400000).toISOString();
    await http()
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(
        disputeEvent({
          disputeId: paypalDisputeId,
          sellerTransactionIds: [captureId],
          disputedAt: openedAt,
          deadlineAt: due,
        }),
      )
      .expect(200);
    await context.app.get(DisputesService).processNextDispute(merchantId);
    const dispute = await prisma.dispute.findFirstOrThrow({
      where: { merchantId, paypalDisputeId },
    });
    const base = `https://api-m.sandbox.paypal.com/v1/customer/disputes/${paypalDisputeId}`;
    const detail = {
      dispute_id: paypalDisputeId,
      create_time: openedAt,
      status: 'WAITING_FOR_SELLER_RESPONSE',
      dispute_life_cycle_stage: 'INQUIRY',
      seller_response_due_date: due,
      disputed_transactions: [{ seller_transaction_id: captureId }],
      messages: [
        {
          posted_by: 'BUYER',
          time_posted: openedAt,
          content: 'No recibí el pedido.',
        },
      ],
      evidences: [],
      links: [
        'send-message',
        'provide-evidence',
        'escalate',
        'provide-supporting-info',
      ].map((rel) => ({ rel, href: `${base}/${rel}`, method: 'POST' })),
    };
    details.set(paypalDisputeId, detail);
    return { dispute, detail, id: dispute.id };
  }
  const start = (id: string, confirmed = true) =>
    mediation.start(actor, id, {
      origin: 'manual',
      confirmed,
      idempotencyKey: randomUUID(),
    });
  const act = (
    id: string,
    action: 'REJECT' | 'CLAIM' | 'SUBMIT' | 'EVALUATE' | 'CONFIRM_DETECTION',
  ) => mediation.action(actor, id, { action, idempotencyKey: randomUUID() });
  function buyer(detail: Record<string, unknown>, content: string) {
    (detail.messages as unknown[]).push({
      posted_by: 'BUYER',
      time_posted: new Date().toISOString(),
      content,
    });
  }
  async function mature(id: string) {
    const now = Date.now();
    await prisma.mediationCase.update({
      where: { disputeId: id },
      data: {
        conciliationDeadline: new Date(now - 3000),
        claimDeadline: new Date(now + 3600000),
      },
    });
  }
  async function evidenceDue(id: string) {
    await prisma.mediationCase.update({
      where: { disputeId: id },
      data: { evidenceDeadline: new Date(Date.now() - 1) },
    });
  }

  it('requires authentication, ownership, admin role and typed input', async () => {
    const { id } = await seed();
    await http().get(`/api/disputes/${id}/mediation`).expect(401);
    await http()
      .get(`/api/disputes/${randomUUID()}/mediation`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    await http()
      .post(`/api/disputes/${id}/mediation`)
      .auth(viewerToken, { type: 'bearer' })
      .send({ origin: 'manual', idempotencyKey: randomUUID() })
      .expect(403);
    await http()
      .post(`/api/disputes/${id}/mediation/messages`)
      .auth(token, { type: 'bearer' })
      .send({ idempotencyKey: randomUUID(), text: 'hola', author: 'BUYER' })
      .expect(400);
  });
  it('does nothing without an existing dispute', async () => {
    const before = writes.length;
    await expect(start(randomUUID())).rejects.toThrow('Dispute not found');
    expect(writes).toHaveLength(before);
  });
  it('serves policy, start, refresh, actions and messages through authenticated HTTP', async () => {
    await http()
      .get('/api/settings/mediation')
      .auth(token, { type: 'bearer' })
      .expect(200);
    await http()
      .put('/api/settings/mediation')
      .auth(token, { type: 'bearer' })
      .send(policy)
      .expect(200);
    const { id } = await seed();
    await http()
      .post(`/api/disputes/${id}/mediation`)
      .auth(token, { type: 'bearer' })
      .send({
        origin: 'manual',
        confirmed: true,
        idempotencyKey: randomUUID(),
        type: 'REFUND_REQUEST',
      })
      .expect(201);
    await http()
      .get(`/api/disputes/${id}/mediation`)
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    await http()
      .post(`/api/disputes/${id}/mediation/refresh`)
      .auth(token, { type: 'bearer' })
      .expect(201);
    await http()
      .post(`/api/disputes/${id}/mediation/messages`)
      .auth(token, { type: 'bearer' })
      .send({ text: 'Mensaje de prueba MOCK.', idempotencyKey: randomUUID() })
      .expect(201);
    const body = { action: 'REJECT', idempotencyKey: randomUUID() };
    await http()
      .post(`/api/disputes/${id}/mediation/actions`)
      .auth(token, { type: 'bearer' })
      .send(body)
      .expect(201);
    await http()
      .post(`/api/disputes/${id}/mediation/actions`)
      .auth(token, { type: 'bearer' })
      .send(body)
      .expect(201);
    await http()
      .post(`/api/disputes/${id}/mediation/actions`)
      .auth(token, { type: 'bearer' })
      .send({ ...body, action: 'CLAIM' })
      .expect(409);
    await http()
      .post(`/api/disputes/${id}/mediation/evidence/files`)
      .auth(token, { type: 'bearer' })
      .send({
        idempotencyKey: randomUUID(),
        file: {
          sourceKind: 'MERCHANT_INPUT',
          sourceSystem: 'MOCK',
          externalReference: 'MOCK-PDF',
          retrievedAt: new Date().toISOString(),
          fileName: 'proof.pdf',
          mediaType: 'application/pdf',
          dataBase64: Buffer.from('%PDF-1.4 MOCK').toString('base64'),
        },
      })
      .expect(409);
  });
  it('automatic discovery processes existing disputes and obeys policy disablement', async () => {
    const { id } = await seed();
    await mediation.tick(merchantId);
    expect((await mediation.view(merchantId, id)).case?.state).toBe(
      'en_conciliacion',
    );
    await mediation.configure(actor, { ...policy, enabled: false });
    const another = await seed();
    await mediation.tick(merchantId);
    expect((await mediation.view(merchantId, another.id)).case).toBeNull();
    await expect(start(another.id)).rejects.toThrow('Configure the merchant');
    await mediation.configure(actor, policy);
  });
  it('updates shorter PayPal deadlines and closes on official resolution', async () => {
    const { id, detail } = await seed();
    await start(id);
    detail.seller_response_due_date = new Date(
      Date.now() + 5 * 86400000,
    ).toISOString();
    await mediation.sync(merchantId, id);
    expect((await mediation.view(merchantId, id)).case?.paypalDeadline).toBe(
      detail.seller_response_due_date,
    );
    detail.status = 'RESOLVED';
    await mediation.sync(merchantId, id);
    expect((await mediation.view(merchantId, id)).case?.state).toBe('cerrado');
    const another = await seed();
    another.detail.disputed_transactions[0]!.seller_transaction_id =
      'OTHER_CAPTURE';
    await expect(start(another.id)).rejects.toThrow('does not match');
  });
  it('persists specialist escalation for a seller threat and rate limits message floods', async () => {
    const { id } = await seed();
    await start(id);
    await expect(
      mediation.message(actor, id, {
        idempotencyKey: randomUUID(),
        text: 'Amenaza de fraude.',
      }),
    ).rejects.toThrow('specialist review');
    expect((await mediation.view(merchantId, id)).case?.humanReviewReason).toBe(
      'THREAT_OR_FRAUD',
    );
    const another = await seed();
    await prisma.mediationMessage.createMany({
      data: Array.from({ length: 10 }, () => ({
        merchantId,
        disputeId: another.id,
        author: 'SELLER',
        sourceKey: randomUUID(),
        text: 'MOCK rate record',
        requestHash: 'a'.repeat(64),
        status: 'SENT',
      })),
    });
    await expect(
      mediation.message(actor, another.id, {
        idempotencyKey: randomUUID(),
        text: 'Otro mensaje',
      }),
    ).rejects.toThrow('Too many messages');
    const env = context.app.get<Environment>(ENVIRONMENT),
      previousLimit = env.MEDIATION_DETECTION_PER_MINUTE;
    try {
      env.MEDIATION_DETECTION_PER_MINUTE = 1;
      await expect(start(another.id)).rejects.toThrow(
        'Too many dispute detection',
      );
    } finally {
      env.MEDIATION_DETECTION_PER_MINUTE = previousLimit;
    }
  });
  it('detects complaint, proposes and closes only after matching bilateral consent and PayPal acknowledgement', async () => {
    const { id, detail } = await seed();
    let view = await start(id, false);
    expect(view.case?.state).toBe('en_conciliacion');
    expect(view.case?.detection?.complaint).toBe(true);
    const proposal = view.case!.proposal!;
    buyer(detail, `ACEPTO ${proposal.id} 1`);
    await mediation.sync(merchantId, id);
    view = await mediation.view(merchantId, id);
    expect(view.case?.state).toBe('en_conciliacion');
    expect(view.case?.buyerAccepted).toBe(0);
    await mediation.action(actor, id, {
      action: 'ACCEPT',
      proposalId: proposal.id,
      option: 0,
      idempotencyKey: randomUUID(),
    });
    await mediation.flushMessages(merchantId, id);
    view = await mediation.view(merchantId, id);
    expect(view.case?.state).toBe('cerrado');
    expect(view.case?.transitions.map((e) => e.to)).toEqual([
      'detectado',
      'abierto',
      'en_conciliacion',
      'acuerdo',
      'cerrado',
    ]);
    expect(
      writes
        .filter((w) => w.url.includes(detail.dispute_id))
        .every((w) => w.url.endsWith('/send-message')),
    ).toBe(true);
  });
  it('low confidence asks for confirmation; false positives do not open conciliation', async () => {
    const { id } = await seed();
    complaint = false;
    detectionConfidence = 0.4;
    let view = await start(id, false);
    expect(view.case?.state).toBe('detectado');
    complaint = true;
    detectionConfidence = 0.99;
    view = await act(id, 'CONFIRM_DETECTION');
    expect(view.case?.state).toBe('en_conciliacion');
  });
  it('keeps idempotent messages persistent and never allows client impersonation', async () => {
    const { id } = await seed(),
      input = {
        idempotencyKey: randomUUID(),
        text: 'Solicito información de entrega.',
      };
    await mediation.message(actor, id, input);
    const sent = writes.length;
    await mediation.message(actor, id, input);
    expect(writes).toHaveLength(sent);
    await expect(
      mediation.message(actor, id, { ...input, text: 'Different content' }),
    ).rejects.toThrow('Idempotency key');
    await mediation.sync(merchantId, id);
    await mediation.sync(merchantId, id);
    const items = (await mediation.view(merchantId, id)).messages;
    expect(items.filter((m) => m.author === 'BUYER')).toHaveLength(1);
    expect(items.find((m) => m.status === 'SENT')!.text).toContain(
      MEDIATION_NOTICE,
    );
  });
  it('expires conciliation, admits seller claim, waits for both parties, evaluates and sends the complete dossier', async () => {
    const { id, detail } = await seed();
    await start(id);
    await expect(act(id, 'CLAIM')).rejects.toThrow('claim requires');
    await mature(id);
    await mediation.expireDue(merchantId);
    expect((await mediation.view(merchantId, id)).case?.state).toBe(
      'sin_acuerdo',
    );
    await act(id, 'CLAIM');
    await expect(act(id, 'EVALUATE')).rejects.toThrow('full evidence window');
    await evidenceDue(id);
    await mediation.advance(merchantId, id);
    const view = await mediation.view(merchantId, id);
    expect(view.case?.state).toBe('escalado_a_paypal');
    expect(view.case?.verdict?.grounds[0]?.evidenceIds.length).toBeGreaterThan(
      0,
    );
    const delivery = writes.find(
      (w) =>
        w.url.includes(detail.dispute_id) &&
        w.url.endsWith('/provide-evidence'),
    )!;
    expect(delivery.body).toBeInstanceOf(FormData);
    const form = delivery.body as FormData,
      file = form.get('mediation-dossier.pdf') as File;
    expect(file.type).toBe('application/pdf');
    expect(await file.text()).toContain('Evidencia equivalente');
    expect(await file.text()).toContain('No recib');
    expect(detail.dispute_life_cycle_stage).toBe('CHARGEBACK');
    const count = writes.length;
    await mediation.submit(merchantId, id);
    expect(writes).toHaveLength(count);
  });
  it('allows buyer rejection and buyer claim only through verified PayPal messages', async () => {
    const { id, detail } = await seed();
    await start(id);
    buyer(detail, 'RECHAZO');
    await mediation.sync(merchantId, id);
    buyer(detail, 'DEMANDA');
    await mediation.sync(merchantId, id);
    const view = await mediation.view(merchantId, id);
    expect(view.case?.state).toBe('recopilando_pruebas');
    expect(
      (
        await prisma.mediationCase.findUniqueOrThrow({
          where: { disputeId: id },
        })
      ).demandBy,
    ).toBe('BUYER');
  });
  it('does not retry ambiguous PayPal writes', async () => {
    const { id } = await seed();
    paypalTimeout = true;
    const input = {
      idempotencyKey: randomUUID(),
      text: 'Respuesta con timeout MOCK.',
    };
    const view = await mediation.message(actor, id, input);
    expect(view.messages.some((m) => m.status === 'UNCERTAIN')).toBe(true);
    const count = writes.length;
    paypalTimeout = false;
    await mediation.message(actor, id, input);
    expect(writes).toHaveLength(count);
  });
  it('recovers a crashed message dispatch as uncertain instead of sending it again', async () => {
    const { id } = await seed();
    await start(id);
    const message = await prisma.mediationMessage.create({
      data: {
        merchantId,
        disputeId: id,
        sourceKey: randomUUID(),
        author: 'SELLER',
        text: 'MOCK interrupted dispatch',
        status: 'SENDING',
        requestHash: 'c'.repeat(64),
      },
    });
    await prisma.mediationAction.create({
      data: {
        merchantId,
        disputeId: id,
        key: `dispatch:${message.id}`,
        hash: message.requestHash,
        createdAt: new Date(Date.now() - 180001),
      },
    });
    const count = writes.length;
    await mediation.sync(merchantId, id);
    const view = await mediation.view(merchantId, id);
    expect(view.messages.find((m) => m.id === message.id)?.status).toBe(
      'UNCERTAIN',
    );
    expect(view.case?.humanReviewReason).toBe(
      'PAYPAL_MESSAGE_REQUIRES_RECONCILIATION',
    );
    await mediation.flushMessages(merchantId, id);
    expect(writes).toHaveLength(count);
  });
  it('retries LLM failures with bounded backoff and escalates repeated failure', async () => {
    const { id } = await seed();
    aiFailure = true;
    await start(id, false);
    await expect(act(id, 'CONFIRM_DETECTION')).rejects.toThrow(
      'validated detection',
    );
    for (let i = 0; i < 2; i++) {
      await prisma.mediationCase.update({
        where: { disputeId: id },
        data: { nextAttemptAt: new Date(0) },
      });
      await mediation.advance(merchantId, id);
    }
    expect((await mediation.view(merchantId, id)).case?.humanReviewReason).toBe(
      'MEDIATION_AGENT_FAILED',
    );
    aiFailure = false;
  });
  it('routes threats to specialist review and preserves the case', async () => {
    const { id, detail } = await seed();
    await start(id);
    buyer(detail, 'Amenaza de fraude.');
    await mediation.sync(merchantId, id);
    expect((await mediation.view(merchantId, id)).case?.humanReviewReason).toBe(
      'THREAT_OR_FRAUD',
    );
    await expect(act(id, 'REJECT')).rejects.toThrow('requires review');
  });
  it('specialist review requires a justification and may close or resume without impersonating the buyer', async () => {
    const { id, detail } = await seed();
    await start(id);
    buyer(detail, 'Amenaza de fraude.');
    await mediation.sync(merchantId, id);
    let view = await mediation.action(actor, id, {
      action: 'REVIEW',
      idempotencyKey: randomUUID(),
      decision: 'RESUME',
      justification:
        'El especialista revisó el contexto y documentó que puede continuar la mediación.',
    });
    expect(view.case?.humanReviewReason).toBeNull();
    buyer(detail, 'Otra amenaza de fraude.');
    await mediation.sync(merchantId, id);
    view = await mediation.action(actor, id, {
      action: 'REVIEW',
      idempotencyKey: randomUUID(),
      decision: 'CLOSE',
      justification:
        'El especialista cierra el flujo interno para gestión externa de este caso difícil.',
    });
    expect(view.case?.state).toBe('cerrado');
    expect(
      view.messages.filter((m) => m.status === 'BLOCKED').length,
    ).toBeGreaterThan(0);
  });
  it('stores original evidence idempotently and rejects unsafe, fictitious and late uploads', async () => {
    const { id } = await seed();
    await start(id);
    await act(id, 'REJECT');
    await act(id, 'CLAIM');
    const put = vi
      .spyOn(context.app.get(EvidenceStorage), 'put')
      .mockResolvedValue(undefined);
    const body = {
      idempotencyKey: randomUUID(),
      file: {
        sourceKind: 'MERCHANT_INPUT',
        sourceSystem: 'MOCK original',
        externalReference: 'MOCK-FILE',
        retrievedAt: new Date().toISOString(),
        fileName: 'proof.pdf',
        mediaType: 'application/pdf',
        dataBase64: Buffer.from('%PDF-1.4 MOCK original text\n%%EOF').toString(
          'base64',
        ),
      },
    };
    const url = `/api/disputes/${id}/mediation/evidence/files`;
    await http()
      .post(url)
      .auth(token, { type: 'bearer' })
      .send(body)
      .expect(201);
    await http()
      .post(url)
      .auth(token, { type: 'bearer' })
      .send(body)
      .expect(201);
    expect(put).toHaveBeenCalledTimes(1);
    await http()
      .post(url)
      .auth(token, { type: 'bearer' })
      .send({ ...body, file: { ...body.file, externalReference: 'OTHER' } })
      .expect(409);
    await http()
      .post(url)
      .auth(token, { type: 'bearer' })
      .send({
        ...body,
        idempotencyKey: randomUUID(),
        file: { ...body.file, sourceKind: 'DEMO' },
      })
      .expect(400);
    await http()
      .post(url)
      .auth(token, { type: 'bearer' })
      .send({
        ...body,
        idempotencyKey: randomUUID(),
        file: {
          ...body.file,
          dataBase64: Buffer.from('%PDF-1.4 /JavaScript forbidden').toString(
            'base64',
          ),
        },
      })
      .expect(422);
    await evidenceDue(id);
    await http()
      .post(url)
      .auth(token, { type: 'bearer' })
      .send({ ...body, idempotencyKey: randomUUID() })
      .expect(409);
    put.mockRestore();
  });
  it('rejects mismatched transaction amounts and currencies', async () => {
    const { id } = await seed();
    await prisma.dispute.update({ where: { id }, data: { amount: '11' } });
    await expect(start(id)).rejects.toThrow('amount or currency');
    await prisma.dispute.update({
      where: { id },
      data: { amount: '10.25', currencyCode: 'EUR' },
    });
    await expect(start(id)).rejects.toThrow('amount or currency');
  });
  it.each([
    'SHIPPING_ERROR',
    'DEFECTIVE_OR_NOT_AS_DESCRIBED',
    'REFUND_REQUEST',
  ])(
    'supports manual reporting of %s with authoritative order/transaction metadata',
    async (type) => {
      const { id } = await seed();
      const view = await mediation.start(actor, id, {
        origin: 'manual',
        confirmed: true,
        type,
        idempotencyKey: randomUUID(),
      });
      expect(view.detectorOutput?.tipo).toBe(type);
      expect(view.detectorOutput?.reportante).toBe('vendedor');
      expect(view.detectorOutput?.monto.value).toBe('10.25');
    },
  );
  it('blocks unreadable PayPal documents instead of pretending to inspect them', async () => {
    const { id, detail } = await seed();
    await start(id);
    await act(id, 'REJECT');
    await act(id, 'CLAIM');
    await evidenceDue(id);
    (detail as Record<string, unknown>).evidences = [
      {
        evidence_type: 'OTHER',
        source: 'PROVIDED_BY_BUYER',
        documents: [{ name: 'MOCK-protected.pdf' }],
      },
    ];
    await mediation.advance(merchantId, id);
    expect((await mediation.view(merchantId, id)).case?.humanReviewReason).toBe(
      'MEDIATION_PAYPAL_DOCUMENT_REVIEW',
    );
  });
  it('downloads, independently reviews and submits original buyer documents when PayPal permits access', async () => {
    const { id, detail } = await seed();
    await start(id);
    await act(id, 'REJECT');
    await act(id, 'CLAIM');
    (detail as Record<string, unknown>).evidences = [
      {
        evidence_type: 'OTHER',
        source: 'PROVIDED_BY_BUYER',
        documents: [
          {
            name: 'original.pdf',
            url: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${detail.dispute_id}/documents/MOCK-FILE`,
          },
        ],
      },
    ];
    (detail as Record<string, unknown>).supporting_info = [
      {
        source: 'SUBMITTED_BY_BUYER',
        notes: 'MOCK buyer supporting information retained.',
        documents: [
          {
            url: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${detail.dispute_id}/documents/MOCK-FILE`,
          },
        ],
      },
    ];
    await evidenceDue(id);
    await mediation.advance(merchantId, id);
    const view = await mediation.view(merchantId, id);
    expect(view.case?.state).toBe('escalado_a_paypal');
    expect(
      view.case?.verdict?.assessedEvidence.some((e) =>
        e.evidenceId.startsWith('paypal-file:'),
      ),
    ).toBe(true);
    const submitted = writes.find(
      (w) =>
        w.url.includes(detail.dispute_id) &&
        w.url.endsWith('/provide-evidence'),
    )!.body as FormData;
    expect(
      [...submitted.keys()].filter((key) => key.startsWith('paypal-')).length,
    ).toBe(1);
    const file = [...submitted.values()].find(
      (value) => value instanceof File && value.name.startsWith('paypal-'),
    ) as File;
    expect(Buffer.from(await file.arrayBuffer())).toEqual(
      dossierPdf({ buyerStatement: 'MOCK original supplied by buyer' }),
    );
  });
  it('enforces exact claim deadline and closes without a demand', async () => {
    const { id } = await seed();
    await start(id);
    await act(id, 'REJECT');
    const now = Date.now();
    await prisma.mediationCase.update({
      where: { disputeId: id },
      data: {
        conciliationDeadline: new Date(now - 1000),
        claimDeadline: new Date(now - 1),
      },
    });
    await expect(act(id, 'CLAIM')).rejects.toThrow('claim requires');
    await mediation.expire(merchantId, id);
    expect((await mediation.view(merchantId, id)).case?.state).toBe('cerrado');
  });
  it('serializes concurrent starts and audits immutable transitions', async () => {
    const { id } = await seed();
    await Promise.all([start(id), start(id)]);
    expect(await prisma.mediationCase.count({ where: { disputeId: id } })).toBe(
      1,
    );
    const row = await prisma.mediationCase.findUniqueOrThrow({
      where: { disputeId: id },
    });
    await expect(
      prisma.mediationTransition.updateMany({
        where: { caseId: row.id },
        data: { reason: 'altered' },
      }),
    ).rejects.toThrow('append-only');
  });
  it('all dispatched operations are nonfinancial and messages include transparency', () => {
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.url).toMatch(
        /\/(send-message|provide-evidence|provide-supporting-info|escalate)$/,
      );
      if (write.url.endsWith('/send-message'))
        expect(JSON.parse(String(write.body)).message).toContain(
          MEDIATION_NOTICE,
        );
    }
    expect(verdictHuman).toBe(false);
  });
});
