import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  MEDIATION_NOTICE,
  MediationPolicySchema,
  MediationViewSchema,
  DetectionSchema,
  ProblemSchema,
  ProposalSchema,
  MediationVerdictSchema,
  MediationActionSchema,
  MediationMessageInputSchema,
  MediationStartSchema,
  MediationEvidenceInputSchema,
  type MediationPolicy,
  type MediationAction,
  type MediationState,
  type MediationView,
} from '@resolve-ai/contracts';
import { Prisma, type MediationCase } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { contentHash } from '../../common/data/content-hash.js';
import { ApiException } from '../../common/http/api.exception.js';
import { MerchantsService, type MerchantActor } from '../merchants/index.js';
import { DisputesService } from '../disputes/index.js';
import { TransactionsService } from '../transactions/index.js';
import {
  MediationPayPalClient,
  type PayPalMediationDetail,
} from '../submissions/index.js';
import { MediationAgents } from './mediation-agents.js';
import { assertTransition, mediationDeadlines } from './mediation-policy.js';
import { dossierPdf } from './dossier-pdf.js';
import { MEDIATION_PROMPT_VERSION } from './prompts/mediation.prompts.js';
import { z } from 'zod';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { AuditService } from '../monitoring/audit.service.js';
import { PdfTextExtractor } from '../evidence/index.js';
import type { AgentMessage } from '../investigator/index.js';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const proposalSchema = ProposalSchema;
const sensitive =
  /\b(fraud|fraude|amenaz\w*|matar\w*|kill|illegal|ilegal|extorsi[oó]n)\b/i;

@Injectable()
export class MediationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DisputesService) private readonly disputes: DisputesService,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(MerchantsService) private readonly merchants: MerchantsService,
    @Inject(MediationPayPalClient)
    private readonly paypal: MediationPayPalClient,
    @Inject(MediationAgents) private readonly agents: MediationAgents,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(PdfTextExtractor) private readonly pdfExtractor: PdfTextExtractor,
  ) {}

  private admin(actor: MerchantActor) {
    if (actor.role !== 'ADMIN')
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'An administrator is required',
        403,
      );
  }
  async policy(merchantId: string) {
    const row = await this.prisma.mediationPolicy.findUnique({
      where: { merchantId },
    });
    return row ? MediationPolicySchema.parse(row.record) : null;
  }
  async configure(actor: MerchantActor, input: MediationPolicy) {
    this.admin(actor);
    const policy = MediationPolicySchema.parse(input);
    await this.merchants.getPolicy(actor.merchantId);
    await this.prisma.$transaction(async (tx) => {
      await tx.mediationPolicy.upsert({
        where: { merchantId: actor.merchantId },
        create: {
          merchantId: actor.merchantId,
          record: json(policy),
          updatedBy: actor.userId,
        },
        update: { record: json(policy), updatedBy: actor.userId },
      });
      await this.audit.append(
        {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          resourceType: 'MEDIATION',
          record: {
            action: 'MEDIATION_EVENT',
            details: {
              event: 'POLICY_UPDATED',
              contentHash: contentHash(policy),
            },
          },
        },
        tx,
      );
    });
    return policy;
  }
  private async context(merchantId: string, disputeId: string, live = false) {
    const dispute = await this.disputes.detail(merchantId, disputeId);
    if (dispute.link.status !== 'LINKED' || !dispute.link.transactionId)
      throw new ApiException(
        'MEDIATION_ORDER_NOT_LINKED',
        'A dispute linked to a verified transaction is required',
        409,
      );
    const snapshot = await this.transactions.investigationSnapshot(
      merchantId,
      dispute.link.transactionId,
    );
    if (
      !snapshot.transaction.order ||
      !snapshot.transaction.order.totalAmount ||
      snapshot.transaction.orderLink.status !== 'LINKED'
    )
      throw new ApiException(
        'MEDIATION_ORDER_REQUIRED',
        'A matching order with a known total is required',
        409,
      );
    if (
      !dispute.amount ||
      dispute.amount.currencyCode !==
        snapshot.transaction.amount.currencyCode ||
      new Prisma.Decimal(dispute.amount.value).lte(0) ||
      new Prisma.Decimal(dispute.amount.value).gt(
        snapshot.transaction.order.totalAmount,
      )
    )
      throw new ApiException(
        'MEDIATION_AMOUNT_INVALID',
        'Dispute amount or currency does not match the order',
        409,
      );
    const detail = live
      ? await this.paypal.detail(merchantId, dispute.paypalDisputeId)
      : null;
    if (
      detail &&
      (detail.disputed_transactions.length !== 1 ||
        detail.disputed_transactions[0]!.seller_transaction_id !==
          snapshot.transaction.paypalCaptureId)
    )
      throw new ApiException(
        'MEDIATION_TRANSACTION_CONFLICT',
        'PayPal dispute does not match the linked transaction',
        409,
      );
    return { dispute, snapshot, detail };
  }
  async view(merchantId: string, disputeId: string): Promise<MediationView> {
    const dispute = await this.disputes.detail(merchantId, disputeId);
    const row = await this.prisma.mediationCase.findFirst({
      where: { merchantId, disputeId },
      include: { events: { orderBy: [{ at: 'asc' }, { id: 'asc' }] } },
    });
    const messages = await this.prisma.mediationMessage.findMany({
      where: { merchantId, disputeId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const linked = row?.detection
      ? await this.transactions.detail(merchantId, row.transactionId)
      : null;
    const origin = row?.events
      .find((e) => e.from === null)
      ?.reason.startsWith('manual:')
      ? 'manual'
      : 'auto';
    return MediationViewSchema.parse({
      detectorOutput:
        row?.detection && linked?.order && dispute.amount
          ? {
              tipo: DetectionSchema.parse(row.detection).type,
              gravedad: DetectionSchema.parse(row.detection).severity,
              resumen: DetectionSchema.parse(row.detection).summary,
              confianza: DetectionSchema.parse(row.detection).confidence,
              case_id: row.id,
              order_id: linked.order.id ?? linked.order.externalId,
              paypal_transaction_id: linked.paypalCaptureId,
              origen: origin,
              reportante: origin === 'manual' ? 'vendedor' : 'cliente',
              monto: dispute.amount,
            }
          : null,
      case: row
        ? {
            ...row,
            conciliationDeadline: row.conciliationDeadline.toISOString(),
            claimDeadline: row.claimDeadline.toISOString(),
            evidenceDeadline: row.evidenceDeadline?.toISOString() ?? null,
            paypalDeadline: row.paypalDeadline.toISOString(),
            transitions: row.events.map((e) => ({
              ...e,
              at: e.at.toISOString(),
            })),
          }
        : null,
      messages: messages.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
      policy: await this.policy(merchantId),
      notice: MEDIATION_NOTICE,
    });
  }
  private async locked<T>(
    merchantId: string,
    disputeId: string,
    operation: (
      tx: Prisma.TransactionClient,
      row: MediationCase | null,
    ) => Promise<T>,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const key = `mediation:${merchantId}:${disputeId}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
        const row = await tx.mediationCase.findFirst({
          where: { merchantId, disputeId },
        });
        return operation(tx, row);
      },
      { timeout: 30000 },
    );
  }
  private async transition(
    tx: Prisma.TransactionClient,
    row: MediationCase,
    to: MediationState,
    agent: string,
    reason: string,
    at = new Date(),
  ) {
    assertTransition(row.state as MediationState, to);
    await tx.mediationTransition.create({
      data: { caseId: row.id, from: row.state, to, agent, reason, at },
    });
    await this.audit.append(
      {
        merchantId: row.merchantId,
        actorUserId: null,
        actorKind: 'AGENT',
        transactionId: row.transactionId,
        resourceType: 'MEDIATION',
        resourceId: row.id,
        record: {
          action: 'MEDIATION_EVENT',
          details: {
            event: 'STATE_CHANGED',
            code: to.toUpperCase(),
            contentHash: contentHash({
              from: row.state,
              to,
              agent,
              reason,
              at,
            }),
          },
        },
      },
      tx,
    );
    row.state = to;
    await tx.mediationCase.update({
      where: { id: row.id },
      data: { state: to },
    });
    if (to === 'cerrado')
      await tx.mediationMessage.updateMany({
        where: {
          merchantId: row.merchantId,
          disputeId: row.disputeId,
          status: 'QUEUED',
        },
        data: { status: 'BLOCKED' },
      });
  }
  private async notice(
    tx: Prisma.TransactionClient,
    row: MediationCase,
    key: string,
    text: string,
    kind = 'NOTICE',
  ) {
    const full = `${text}\n\n${MEDIATION_NOTICE}`;
    if (full.length > 2000)
      throw new ApiException(
        'MEDIATION_MESSAGE_LIMIT',
        'Mediation message exceeds the PayPal limit',
        422,
      );
    await tx.mediationMessage.upsert({
      where: {
        merchantId_disputeId_sourceKey: {
          merchantId: row.merchantId,
          disputeId: row.disputeId,
          sourceKey: key,
        },
      },
      create: {
        merchantId: row.merchantId,
        disputeId: row.disputeId,
        sourceKey: key,
        author: 'AGENT',
        text: full,
        kind,
        requestHash: contentHash(full),
      },
      update: {},
    });
  }
  async message(
    actor: MerchantActor,
    disputeId: string,
    input: { idempotencyKey: string; text: string },
  ) {
    this.admin(actor);
    input = MediationMessageInputSchema.parse(input);
    const ctx = await this.context(actor.merchantId, disputeId, true);
    if (!this.paypal.can(ctx.detail!, 'send-message'))
      throw new ApiException(
        'PAYPAL_ACTION_UNAVAILABLE',
        'PayPal does not permit messages in this dispute',
        409,
      );
    const text = `${input.text}\n\n${MEDIATION_NOTICE}`,
      hash = contentHash({ text, userId: actor.userId });
    const blocked = await this.locked(
      actor.merchantId,
      disputeId,
      async (tx, row) => {
        const where = {
          merchantId_disputeId_sourceKey: {
            merchantId: actor.merchantId,
            disputeId,
            sourceKey: input.idempotencyKey,
          },
        };
        const existing = await tx.mediationMessage.findUnique({ where });
        if (existing) {
          if (existing.requestHash !== hash)
            throw new ApiException(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency key was used for different content',
              409,
            );
          return existing.status === 'BLOCKED';
        }
        if (
          (await tx.mediationMessage.count({
            where: {
              merchantId: actor.merchantId,
              disputeId,
              createdAt: { gte: new Date(Date.now() - 60000) },
              author: 'SELLER',
            },
          })) >= 10
        )
          throw new ApiException(
            'MEDIATION_RATE_LIMIT',
            'Too many messages',
            429,
          );
        if (sensitive.test(input.text)) {
          await tx.mediationMessage.create({
            data: {
              merchantId: actor.merchantId,
              disputeId,
              sourceKey: input.idempotencyKey,
              author: 'SELLER',
              text,
              actorUserId: actor.userId,
              requestHash: hash,
              status: 'BLOCKED',
            },
          });
          if (row) await this.human(tx, row, 'THREAT_OR_FRAUD');
          return true;
        }
        await tx.mediationMessage.create({
          data: {
            merchantId: actor.merchantId,
            disputeId,
            sourceKey: input.idempotencyKey,
            author: 'SELLER',
            text,
            actorUserId: actor.userId,
            requestHash: hash,
          },
        });
      },
    );
    if (blocked)
      throw new ApiException(
        'MEDIATION_HUMAN_REQUIRED',
        'This message requires specialist review',
        422,
      );
    await this.flushMessages(actor.merchantId, disputeId);
    return this.view(actor.merchantId, disputeId);
  }
  async start(
    actor: MerchantActor,
    disputeId: string,
    input: {
      idempotencyKey: string;
      origin: 'auto' | 'manual';
      confirmed?: boolean;
      type?: string;
    },
  ) {
    this.admin(actor);
    const parsed = MediationStartSchema.parse(input);
    await this.ensureCase(
      actor.merchantId,
      disputeId,
      parsed.origin,
      parsed.confirmed,
      parsed.type,
    );
    await this.advance(actor.merchantId, disputeId);
    return this.view(actor.merchantId, disputeId);
  }
  private async ensureCase(
    merchantId: string,
    disputeId: string,
    origin: 'auto' | 'manual',
    confirmed = false,
    type?: string,
  ) {
    const policy = await this.policy(merchantId);
    if (!policy?.enabled)
      throw new ApiException(
        'MEDIATION_NOT_CONFIGURED',
        'Configure the merchant mediation policy first',
        409,
      );
    const { dispute, snapshot, detail } = await this.context(
      merchantId,
      disputeId,
      true,
    );
    if (
      detail!.status === 'RESOLVED' ||
      detail!.dispute_life_cycle_stage !== 'INQUIRY'
    )
      throw new ApiException(
        'MEDIATION_NOT_ELIGIBLE',
        'Only an existing open PayPal inquiry can enter conciliation',
        409,
      );
    const deadline = mediationDeadlines(
      policy,
      new Date(),
      new Date(detail!.create_time),
      detail!.seller_response_due_date
        ? new Date(detail!.seller_response_due_date)
        : dispute.deadlineAt
          ? new Date(dispute.deadlineAt)
          : null,
    );
    await this.locked(merchantId, disputeId, async (tx, existing) => {
      if (existing) return;
      const detectionKey = `mediation-detection:${merchantId}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${detectionKey}, 0))::text`;
      if (
        (await tx.mediationCase.count({
          where: {
            merchantId,
            createdAt: { gte: new Date(Date.now() - 60000) },
          },
        })) >= this.env.MEDIATION_DETECTION_PER_MINUTE
      )
        throw new ApiException(
          'MEDIATION_RATE_LIMIT',
          'Too many dispute detection requests',
          429,
        );
      const row = await tx.mediationCase.create({
        data: {
          merchantId,
          disputeId,
          transactionId: snapshot.transaction.id,
          policy: json(policy),
          conciliationDeadline: deadline.conciliation,
          claimDeadline: deadline.claim,
          paypalDeadline: deadline.paypal,
        },
      });
      await tx.mediationTransition.create({
        data: {
          caseId: row.id,
          from: null,
          to: 'detectado',
          agent: 'DETECTOR',
          reason: `${origin}:${type ?? dispute.reasonCategory}:${MEDIATION_PROMPT_VERSION}`,
        },
      });
      if (confirmed && origin === 'manual') {
        await tx.mediationAction.create({
          data: {
            merchantId,
            disputeId,
            key: 'manual-confirmed',
            hash: contentHash({ confirmed, type: type ?? null }),
          },
        });
      }
    });
    await this.sync(merchantId, disputeId, detail!);
  }
  async refresh(actor: MerchantActor, disputeId: string) {
    this.admin(actor);
    await this.context(actor.merchantId, disputeId);
    await this.sync(actor.merchantId, disputeId);
    await this.advance(actor.merchantId, disputeId);
    await this.flushMessages(actor.merchantId, disputeId);
    return this.view(actor.merchantId, disputeId);
  }
  async evidence(
    actor: MerchantActor,
    disputeId: string,
    input: z.infer<typeof MediationEvidenceInputSchema>,
  ) {
    this.admin(actor);
    input = MediationEvidenceInputSchema.parse(input);
    await this.context(actor.merchantId, disputeId);
    await this.locked(actor.merchantId, disputeId, async (tx, row) => {
      if (!row)
        throw new ApiException(
          'MEDIATION_NOT_FOUND',
          'Mediation case not found',
          404,
        );
      const key = {
          merchantId_disputeId_key: {
            merchantId: actor.merchantId,
            disputeId,
            key: input.idempotencyKey,
          },
        },
        hash = contentHash(input);
      const existing = await tx.mediationAction.findUnique({ where: key });
      if (existing) {
        if (existing.hash !== hash)
          throw new ApiException(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key conflict',
            409,
          );
        return;
      }
      const deadline =
        row.state === 'en_conciliacion'
          ? row.conciliationDeadline
          : row.state === 'recopilando_pruebas'
            ? row.evidenceDeadline
            : null;
      if (row.humanReviewReason || !deadline || new Date() >= deadline)
        throw new ApiException(
          'MEDIATION_EVIDENCE_EXPIRED',
          'The evidence collection window is closed',
          409,
        );
      if (
        (await tx.mediationAction.count({
          where: {
            merchantId: actor.merchantId,
            disputeId,
            createdAt: { gte: new Date(Date.now() - 60000) },
          },
        })) >= 10
      )
        throw new ApiException(
          'MEDIATION_RATE_LIMIT',
          'Too many evidence requests',
          429,
        );
      await this.transactions.uploadEvidenceFile(
        actor,
        row.transactionId,
        input.file,
        tx,
      );
      await tx.mediationAction.create({
        data: { ...key.merchantId_disputeId_key, hash },
      });
    });
    return this.view(actor.merchantId, disputeId);
  }
  private async human(
    tx: Prisma.TransactionClient,
    row: MediationCase,
    reason: string,
  ) {
    await this.audit.append(
      {
        merchantId: row.merchantId,
        actorUserId: null,
        actorKind: 'SYSTEM',
        transactionId: row.transactionId,
        resourceType: 'MEDIATION',
        resourceId: row.id,
        outcome: 'BLOCKED',
        record: {
          action: 'MEDIATION_EVENT',
          details: { event: 'HUMAN_REVIEW', code: reason },
        },
      },
      tx,
    );
    await tx.mediationCase.update({
      where: { id: row.id },
      data: { humanReviewReason: reason, leaseUntil: null },
    });
    await this.notice(
      tx,
      row,
      `human:${reason}`,
      'El caso requiere revisión especializada. Se conservan las pruebas y los plazos de PayPal.',
    );
  }
  async sync(
    merchantId: string,
    disputeId: string,
    known?: PayPalMediationDetail,
  ) {
    const ctx = await this.context(merchantId, disputeId, !known);
    const detail = known ?? ctx.detail!;
    await this.locked(merchantId, disputeId, async (tx, row) => {
      for (const message of detail.messages) {
        const key = `paypal:${contentHash(message)}`;
        const unique = {
          merchantId_disputeId_sourceKey: {
            merchantId,
            disputeId,
            sourceKey: key,
          },
        };
        if (await tx.mediationMessage.findUnique({ where: unique })) continue;
        if (message.posted_by === 'SELLER') {
          const local = await tx.mediationMessage.findFirst({
            where: {
              merchantId,
              disputeId,
              author: { in: ['SELLER', 'AGENT'] },
              text: message.content,
              status: { in: ['SENT', 'SENDING', 'UNCERTAIN'] },
              createdAt: { lte: new Date(message.time_posted) },
            },
          });
          if (local) {
            await tx.mediationMessage.update({
              where: { id: local.id },
              data: { status: 'SENT' },
            });
            if (local.kind === 'AGREEMENT' && row?.state === 'acuerdo')
              await this.transition(
                tx,
                row,
                'cerrado',
                'CONCILIATOR',
                'AGREEMENT_NOTIFICATION_RECONCILED',
              );
            continue;
          }
        }
        await tx.mediationMessage.create({
          data: {
            merchantId,
            disputeId,
            sourceKey: key,
            author: message.posted_by,
            text: message.content,
            status: 'RECEIVED',
            requestHash: contentHash(message),
            createdAt: new Date(message.time_posted),
          },
        });
        if (row && !row.humanReviewReason && message.posted_by === 'BUYER') {
          if (sensitive.test(message.content)) {
            await this.human(tx, row, 'THREAT_OR_FRAUD');
            row.humanReviewReason = 'THREAT_OR_FRAUD';
          } else
            await this.buyerCommand(
              tx,
              row,
              message.content,
              new Date(message.time_posted),
            );
        }
      }
      if (!row) return;
      if (detail.status === 'RESOLVED') {
        if (row.state !== 'cerrado')
          await this.transition(
            tx,
            row,
            'cerrado',
            'PAYPAL',
            'PAYPAL_RESOLVED',
          );
        return;
      }
      if (
        detail.seller_response_due_date &&
        new Date(detail.seller_response_due_date) < row.paypalDeadline
      ) {
        const deadline = new Date(detail.seller_response_due_date);
        const p = MediationPolicySchema.parse(row.policy);
        const safeEnd = deadline.getTime() - p.deadlineMarginHours * 3600000;
        const claimDeadline = new Date(
          Math.min(
            row.claimDeadline.getTime(),
            safeEnd - p.evidenceHours * 3600000,
          ),
        );
        const conciliationDeadline = new Date(
          Math.min(
            row.conciliationDeadline.getTime(),
            claimDeadline.getTime() - p.claimHours * 3600000,
          ),
        );
        await tx.mediationCase.update({
          where: { id: row.id },
          data: {
            paypalDeadline: deadline,
            claimDeadline,
            conciliationDeadline,
            ...(row.evidenceDeadline
              ? {
                  evidenceDeadline: new Date(
                    Math.min(row.evidenceDeadline.getTime(), safeEnd),
                  ),
                }
              : {}),
          },
        });
        if (safeEnd <= Date.now())
          await this.human(tx, row, 'PAYPAL_DEADLINE_CHANGED');
      }
      // Resolve only exact matches after uncertain message dispatch, never blindly resend.
      const uncertain = await tx.mediationMessage.findMany({
        where: {
          merchantId,
          disputeId,
          status: { in: ['SENDING', 'UNCERTAIN'] },
        },
      });
      for (const m of uncertain)
        if (
          detail.messages.some(
            (p) =>
              p.posted_by === 'SELLER' &&
              p.content === m.text &&
              new Date(p.time_posted) >= m.createdAt,
          )
        )
          await tx.mediationMessage.update({
            where: { id: m.id },
            data: { status: 'SENT' },
          });
        else {
          const dispatch = await tx.mediationAction.findUnique({
            where: {
              merchantId_disputeId_key: {
                merchantId,
                disputeId,
                key: `dispatch:${m.id}`,
              },
            },
          });
          if (
            m.status === 'UNCERTAIN' ||
            (dispatch && dispatch.createdAt.getTime() + 180000 <= Date.now())
          ) {
            await tx.mediationMessage.update({
              where: { id: m.id },
              data: { status: 'UNCERTAIN' },
            });
            if (row && !row.humanReviewReason)
              await this.human(
                tx,
                row,
                'PAYPAL_MESSAGE_REQUIRES_RECONCILIATION',
              );
          }
        }
      const delivery = await tx.mediationDelivery.findUnique({
        where: { caseId: row.id },
      });
      if (
        delivery?.status === 'SENDING' &&
        delivery.updatedAt.getTime() + 180000 <= Date.now() &&
        !row.humanReviewReason
      )
        await this.human(tx, row, 'PAYPAL_DELIVERY_REQUIRES_RECONCILIATION');
    });
  }
  private async buyerCommand(
    tx: Prisma.TransactionClient,
    row: MediationCase,
    text: string,
    at: Date,
  ) {
    if (at < row.createdAt || at.getTime() > Date.now() + 300000) return;
    const accept = /^ACEPTO ([a-f0-9-]{36}) ([1-5])$/i.exec(text.trim());
    if (
      accept &&
      row.state === 'en_conciliacion' &&
      at < row.conciliationDeadline &&
      (row.proposal as { id?: string } | null)?.id === accept[1] &&
      Number(accept[2]) <=
        proposalSchema.parse((row.proposal as { result: unknown }).result)
          .options.length
    )
      await this.accept(tx, row, 'BUYER', accept[1]!, Number(accept[2]) - 1);
    if (
      /^RECHAZO$/i.test(text.trim()) &&
      row.state === 'en_conciliacion' &&
      at < row.conciliationDeadline
    ) {
      await this.transition(
        tx,
        row,
        'sin_acuerdo',
        'CONCILIATOR',
        'BUYER_REJECTED',
        at,
      );
      await this.notice(
        tx,
        row,
        'no-agreement',
        'Sin acuerdo. Cualquiera de las partes puede presentar DEMANDA dentro del plazo indicado en el caso.',
      );
    }
    if (
      /^DEMANDA$/i.test(text.trim()) &&
      row.state === 'sin_acuerdo' &&
      at < row.claimDeadline
    )
      await this.claim(tx, row, 'BUYER', at);
  }
  private async accept(
    tx: Prisma.TransactionClient,
    row: MediationCase,
    party: 'BUYER' | 'SELLER',
    proposalId: string,
    option: number,
  ) {
    const proposal = row.proposal as { id: string; result: unknown } | null;
    if (
      !proposal ||
      proposal.id !== proposalId ||
      !proposalSchema.parse(proposal.result).options[option]
    )
      throw new ApiException(
        'MEDIATION_PROPOSAL_MISMATCH',
        'Confirm an existing option of the current proposal',
        409,
      );
    if (party === 'BUYER') row.buyerAccepted = option;
    else row.sellerAccepted = option;
    await tx.mediationCase.update({
      where: { id: row.id },
      data: {
        buyerAccepted: row.buyerAccepted,
        sellerAccepted: row.sellerAccepted,
      },
    });
    if (
      row.buyerAccepted !== null &&
      row.buyerAccepted === row.sellerAccepted
    ) {
      await this.transition(
        tx,
        row,
        'acuerdo',
        'CONCILIATOR',
        'BOTH_PARTIES_CONFIRMED',
      );
      const selected = proposalSchema.parse(proposal.result).options[option]!;
      await this.notice(
        tx,
        row,
        'agreement',
        `Acta ${proposal.id}: ambas partes confirmaron la opción ${option + 1}. ${selected.description}\nEs una acción acordada para que las partes y PayPal la gestionen; no se ejecutó ninguna operación financiera.`,
        'AGREEMENT',
      );
    }
  }
  private async claim(
    tx: Prisma.TransactionClient,
    row: MediationCase,
    party: string,
    at: Date,
  ) {
    const policy = MediationPolicySchema.parse(row.policy);
    await this.transition(
      tx,
      row,
      'demanda_admitida',
      'EVALUATOR',
      `${party}_CLAIM`,
      at,
    );
    await this.transition(
      tx,
      row,
      'recopilando_pruebas',
      'EVALUATOR',
      'EVIDENCE_REQUESTED',
      at,
    );
    const deadline = new Date(
      Math.min(
        at.getTime() + policy.evidenceHours * 3600000,
        row.paypalDeadline.getTime() - policy.deadlineMarginHours * 3600000,
      ),
    );
    await tx.mediationCase.update({
      where: { id: row.id },
      data: { demandBy: party, evidenceDeadline: deadline },
    });
    await this.notice(
      tx,
      row,
      'evidence-request',
      `Demanda admitida. Ambas partes pueden aportar sus pruebas hasta ${deadline.toISOString()}. El comprador las aporta en PayPal; el vendedor puede utilizar el expediente del caso.`,
    );
  }
  async action(
    actor: MerchantActor,
    disputeId: string,
    input: MediationAction,
  ) {
    this.admin(actor);
    input = MediationActionSchema.parse(input);
    const ctx = await this.context(actor.merchantId, disputeId, true);
    await this.locked(actor.merchantId, disputeId, async (tx, row) => {
      if (!row)
        throw new ApiException(
          'MEDIATION_NOT_FOUND',
          'Mediation case not found',
          404,
        );
      const key = {
          merchantId_disputeId_key: {
            merchantId: actor.merchantId,
            disputeId,
            key: input.idempotencyKey,
          },
        },
        hash = contentHash({ input, actor: actor.userId });
      const existing = await tx.mediationAction.findUnique({ where: key });
      if (existing) {
        if (existing.hash !== hash)
          throw new ApiException(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key conflict',
            409,
          );
        return;
      }
      if (input.action === 'REVIEW') {
        if (!row.humanReviewReason)
          throw new ApiException(
            'MEDIATION_REVIEW_NOT_REQUIRED',
            'This case does not require specialist review',
            409,
          );
        if (
          input.decision === 'RESUME' &&
          ((await tx.mediationDelivery.count({
            where: { caseId: row.id, status: { in: ['UNCERTAIN', 'SENDING'] } },
          })) ||
            (await tx.mediationMessage.count({
              where: {
                merchantId: actor.merchantId,
                disputeId,
                status: { in: ['UNCERTAIN', 'SENDING'] },
              },
            })))
        )
          throw new ApiException(
            'MEDIATION_RECONCILIATION_REQUIRED',
            'Reconcile uncertain PayPal deliveries before resuming',
            409,
          );
        await tx.mediationMessage.create({
          data: {
            merchantId: actor.merchantId,
            disputeId,
            sourceKey: `review:${input.idempotencyKey}`,
            author: 'SELLER',
            kind: 'HUMAN_REVIEW',
            text: input.justification,
            status: 'BLOCKED',
            actorUserId: actor.userId,
            requestHash: hash,
          },
        });
        await tx.mediationCase.update({
          where: { id: row.id },
          data: {
            humanReviewReason: null,
            failures: 0,
            nextAttemptAt: new Date(),
            leaseUntil: null,
          },
        });
        if (input.decision === 'CLOSE')
          await this.transition(
            tx,
            row,
            'cerrado',
            'SPECIALIST',
            'SPECIALIST_CLOSED_CASE',
          );
        await this.audit.append(
          {
            merchantId: actor.merchantId,
            actorUserId: actor.userId,
            resourceType: 'MEDIATION',
            resourceId: row.id,
            record: {
              action: 'MEDIATION_EVENT',
              details: {
                event: 'ACTION',
                code: `SPECIALIST_${input.decision}`,
                contentHash: hash,
              },
            },
          },
          tx,
        );
        await tx.mediationAction.create({
          data: { ...key.merchantId_disputeId_key, hash },
        });
        return;
      }
      if (row.humanReviewReason || ctx.detail!.status === 'RESOLVED')
        throw new ApiException(
          'MEDIATION_ACTION_BLOCKED',
          'This case requires review or is already resolved',
          409,
        );
      const now = new Date();
      if (now >= row.paypalDeadline)
        throw new ApiException(
          'MEDIATION_DEADLINE_EXPIRED',
          'PayPal deadline expired',
          409,
        );
      if (
        input.action === 'CONFIRM_DETECTION' &&
        !DetectionSchema.safeParse(row.detection).success
      )
        throw new ApiException(
          'MEDIATION_DETECTION_PENDING',
          'A validated detection is required before confirmation',
          409,
        );
      if (input.action === 'CONFIRM_DETECTION')
        await this.transition(
          tx,
          row,
          'abierto',
          'DETECTOR',
          'SELLER_CONFIRMED',
        );
      if (input.action === 'ACCEPT' || input.action === 'REJECT') {
        if (row.state !== 'en_conciliacion' || now >= row.conciliationDeadline)
          throw new ApiException(
            'MEDIATION_CONCILIATION_EXPIRED',
            'Conciliation is not open',
            409,
          );
        if (input.action === 'ACCEPT')
          await this.accept(tx, row, 'SELLER', input.proposalId, input.option);
        else {
          await this.transition(
            tx,
            row,
            'sin_acuerdo',
            'CONCILIATOR',
            'SELLER_REJECTED',
          );
          await this.notice(
            tx,
            row,
            'no-agreement',
            `Sin acuerdo. Puede presentar DEMANDA hasta ${row.claimDeadline.toISOString()}.`,
          );
        }
      }
      if (input.action === 'CLAIM') {
        if (row.state !== 'sin_acuerdo' || now >= row.claimDeadline)
          throw new ApiException(
            'MEDIATION_CLAIM_NOT_ADMISSIBLE',
            'A claim requires no agreement and an open claim window',
            409,
          );
        await this.claim(tx, row, 'SELLER', now);
      }
      if (
        input.action === 'EVALUATE' &&
        (row.state !== 'recopilando_pruebas' ||
          !row.evidenceDeadline ||
          now < row.evidenceDeadline)
      )
        throw new ApiException(
          'MEDIATION_EVIDENCE_WINDOW_OPEN',
          'Both parties must have their full evidence window',
          409,
        );
      if (input.action === 'SUBMIT' && row.state !== 'dictaminado')
        throw new ApiException(
          'MEDIATION_VERDICT_REQUIRED',
          'A verified verdict is required',
          409,
        );
      await this.audit.append(
        {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          transactionId: row.transactionId,
          resourceType: 'MEDIATION',
          resourceId: row.id,
          record: {
            action: 'MEDIATION_EVENT',
            details: { event: 'ACTION', code: input.action, contentHash: hash },
          },
        },
        tx,
      );
      await tx.mediationAction.create({
        data: { ...key.merchantId_disputeId_key, hash },
      });
    });
    await this.advance(actor.merchantId, disputeId);
    if (input.action === 'SUBMIT')
      await this.submit(actor.merchantId, disputeId, true);
    await this.flushMessages(actor.merchantId, disputeId);
    return this.view(actor.merchantId, disputeId);
  }
  async advance(merchantId: string, disputeId: string) {
    const acquired = await this.locked(
      merchantId,
      disputeId,
      async (tx, row) => {
        if (
          !row ||
          row.humanReviewReason ||
          row.state === 'cerrado' ||
          row.nextAttemptAt > new Date() ||
          (row.leaseUntil && row.leaseUntil > new Date())
        )
          return null;
        await tx.mediationCase.update({
          where: { id: row.id },
          data: { leaseUntil: new Date(Date.now() + 180000) },
        });
        return row;
      },
    );
    if (!acquired) return;
    try {
      const row = acquired,
        policy = MediationPolicySchema.parse(row.policy);
      await this.merchants.assertActionAllowed(merchantId, 'INVESTIGATE');
      const { dispute, snapshot, detail } = await this.context(
        merchantId,
        disputeId,
        true,
      );
      const messages = await this.prisma.mediationMessage.findMany({
        where: { merchantId, disputeId, status: { in: ['RECEIVED', 'SENT'] } },
        orderBy: { createdAt: 'asc' },
        take: 257,
      });
      if (messages.length > 256)
        throw new ApiException(
          'MEDIATION_CONTEXT_REVIEW',
          'The full conversation exceeds the automated review budget',
          409,
        );
      const paypalEvidence = [
        ...detail!.evidences,
        ...detail!.supporting_info.map((e) => ({
          ...e,
          evidence_type: 'SUPPORTING_INFORMATION',
        })),
      ].map((e) => ({
        ...e,
        id: `paypal-evidence:${contentHash(e)}`,
      }));
      const originEvent = await this.prisma.mediationTransition.findFirst({
        where: { caseId: row.id, from: null },
        orderBy: { at: 'asc' },
      });
      const reportedProblemType = originEvent?.reason.split(':')[1];
      const data = {
        reportedProblemType,
        dispute,
        order: snapshot.transaction.order,
        messages,
        paypalEvidence,
      };
      if (row.state === 'detectado' && row.detection === null) {
        const detection = await this.agents.detect(data);
        const manualType = ProblemSchema.safeParse(reportedProblemType);
        if (originEvent?.reason.startsWith('manual:') && manualType.success)
          detection.type = manualType.data;
        await this.locked(merchantId, disputeId, async (tx, current) => {
          if (!current || current.state !== 'detectado') return;
          await tx.mediationCase.update({
            where: { id: row.id },
            data: { detection: json(DetectionSchema.parse(detection)) },
          });
          if (detection.humanReview)
            await this.human(tx, current, 'DETECTOR_REVIEW_REQUIRED');
          else if (
            (detection.complaint && detection.confidence >= 0.85) ||
            (await tx.mediationAction.findUnique({
              where: {
                merchantId_disputeId_key: {
                  merchantId,
                  disputeId,
                  key: 'manual-confirmed',
                },
              },
            }))
          )
            await this.transition(
              tx,
              current,
              'abierto',
              'DETECTOR',
              'COMPLAINT_CONFIRMED',
            );
          else
            await this.notice(
              tx,
              current,
              'confirm-detection',
              'La intención de queja no es clara. Confirme si desea iniciar la mediación.',
            );
        });
      }
      const latest = await this.prisma.mediationCase.findUniqueOrThrow({
        where: { id: row.id },
      });
      if (latest.state === 'abierto' && !latest.humanReviewReason) {
        const result = await this.agents.conciliate(data, policy);
        await this.locked(merchantId, disputeId, async (tx, current) => {
          if (
            !current ||
            current.state !== 'abierto' ||
            current.humanReviewReason
          )
            return;
          if (result.humanReview) {
            await this.human(tx, current, 'CONCILIATOR_REVIEW_REQUIRED');
            return;
          }
          const id = randomUUID();
          await tx.mediationCase.update({
            where: { id: row.id },
            data: { proposal: json({ id, result }) },
          });
          await this.transition(
            tx,
            current,
            'en_conciliacion',
            'CONCILIATOR',
            'PROPOSAL_CREATED',
          );
          const options = result.options
            .map((o, i) => `${i + 1}. ${o.description}`)
            .join('\n');
          await this.notice(
            tx,
            current,
            'proposal',
            `Mediación abierta hasta ${current.conciliationDeadline.toISOString()}.\n${options}\nPara aceptar, responda en PayPal: ACEPTO ${id} N (sustituya N por el número de opción). Para rechazar: RECHAZO. Sin acuerdo, puede presentar DEMANDA hasta ${current.claimDeadline.toISOString()}.`,
          );
        });
      }
      await this.expire(merchantId, disputeId);
      const ready = await this.prisma.mediationCase.findUniqueOrThrow({
        where: { id: row.id },
      });
      if (
        ready.state === 'recopilando_pruebas' &&
        ready.evidenceDeadline &&
        ready.evidenceDeadline <= new Date() &&
        !ready.humanReviewReason
      ) {
        if (
          snapshot.dossier.items.some(
            (i) =>
              i.recordedAt && new Date(i.recordedAt) > ready.evidenceDeadline!,
          )
        )
          throw new ApiException(
            'MEDIATION_LATE_EVIDENCE_REVIEW',
            'Evidence added outside the collection window requires specialist review',
            409,
          );
        const latestSource = await this.paypal.detail(
          merchantId,
          dispute.paypalDisputeId,
        );
        if (
          contentHash({
            messages: latestSource.messages,
            evidence: latestSource.evidences,
            supporting: latestSource.supporting_info,
          }) !==
          contentHash({
            messages: detail!.messages,
            evidence: detail!.evidences,
            supporting: detail!.supporting_info,
          })
        )
          throw new ApiException(
            'MEDIATION_EVIDENCE_STALE',
            'PayPal evidence changed during case preparation',
            409,
          );
        const remoteFiles = await this.paypal.documents(merchantId, detail!);
        const paypalFiles: {
          id: string;
          reference: string;
          sha256: string;
          mediaType: string;
          byteLength: number;
          extractedText?: string;
        }[] = [];
        const remoteOriginals: AgentMessage[] = [];
        for (const file of remoteFiles) {
          const metadata = {
            id: file.id,
            reference: file.reference,
            sha256: file.sha256,
            mediaType: file.mediaType,
            byteLength: file.bytes.length,
          };
          if (file.mediaType === 'application/pdf') {
            const extractedText = await this.pdfExtractor.extract(file.bytes);
            if (!extractedText.trim())
              throw new ApiException(
                'MEDIATION_PAYPAL_DOCUMENT_REVIEW',
                'The original PayPal PDF could not be inspected',
                409,
              );
            paypalFiles.push({ ...metadata, extractedText });
            remoteOriginals.push({
              role: 'user',
              text: JSON.stringify({
                untrustedOriginal: file.id,
                extractedText,
              }),
            });
          } else {
            paypalFiles.push(metadata);
            remoteOriginals.push({
              role: 'user',
              text: `UNTRUSTED PAYPAL ORIGINAL ${file.id}`,
              image: {
                mediaType: file.mediaType,
                base64: file.bytes.toString('base64'),
              },
            });
          }
        }
        const evaluation = await this.agents.evaluate(
          merchantId,
          ready.transactionId,
          { ...data, paypalFiles },
          policy,
          [
            ...messages.map((m) => m.id),
            ...paypalEvidence.map((e) => e.id),
            ...paypalFiles.map((f) => f.id),
          ],
          remoteOriginals,
        );
        if (evaluation.verdict.humanReview)
          throw new ApiException(
            'MEDIATION_EVALUATOR_REVIEW',
            'Evaluation requires specialist review',
            409,
          );
        await this.locked(merchantId, disputeId, async (tx, current) => {
          if (
            !current ||
            current.state !== 'recopilando_pruebas' ||
            current.humanReviewReason
          )
            return;
          await this.transition(
            tx,
            current,
            'dictaminado',
            'EVALUATOR',
            'INDEPENDENT_REVIEW_PASSED',
          );
          const chronology = await tx.mediationTransition.findMany({
            where: { caseId: row.id },
            orderBy: { at: 'asc' },
          });
          const packet = {
            promptVersion: MEDIATION_PROMPT_VERSION,
            summary: evaluation.verdict.summary,
            chronology,
            evidence: evaluation.evidence,
            history: evaluation.history,
            messages,
            paypalEvidence,
            paypalFiles,
            paypalSourceHash: this.paypalSourceHash(
              detail!,
              messages.filter((m) => m.author === 'AGENT').map((m) => m.text),
            ),
            verdict: evaluation.verdict,
            independentReview: evaluation.review,
            policy,
          };
          await tx.mediationAction.create({
            data: {
              merchantId,
              disputeId,
              key: 'packet-hash',
              hash: contentHash(JSON.parse(JSON.stringify(packet))),
            },
          });
          await tx.mediationCase.update({
            where: { id: row.id },
            data: {
              verdict: json(evaluation.verdict),
              packet: json(JSON.parse(JSON.stringify(packet))),
              evidenceRevision: evaluation.evidenceRevision,
            },
          });
          await this.notice(
            tx,
            current,
            'verdict',
            `Dictamen interno: ${evaluation.verdict.recommendation}. ${evaluation.verdict.summary}`,
          );
        });
      }
      if (policy.automaticSubmission) await this.submit(merchantId, disputeId);
    } catch (error) {
      const code =
        error instanceof ApiException
          ? error.code
          : error instanceof Error &&
              'code' in error &&
              typeof error.code === 'string'
            ? error.code
            : 'MEDIATION_AGENT_FAILED';
      await this.locked(merchantId, disputeId, async (tx, row) => {
        if (!row) return;
        const failures = row.failures + 1;
        await this.audit.append(
          {
            merchantId,
            actorUserId: null,
            actorKind: 'AGENT',
            resourceType: 'MEDIATION',
            resourceId: row.id,
            outcome: 'FAILED',
            record: {
              action: 'MEDIATION_EVENT',
              details: { event: 'AGENT_RESULT', code },
            },
          },
          tx,
        );
        await tx.mediationCase.update({
          where: { id: row.id },
          data: {
            failures,
            nextAttemptAt: new Date(
              Date.now() + Math.min(300000, 5000 * 2 ** failures),
            ),
          },
        });
        if (
          failures >= 3 ||
          /REVIEW|INVALID|REJECTED|UNSAFE|CITATION|STALE/.test(code)
        )
          await this.human(tx, row, code.slice(0, 128));
      });
    } finally {
      await this.prisma.mediationCase.updateMany({
        where: { id: acquired.id },
        data: { leaseUntil: null },
      });
    }
  }
  async expire(merchantId: string, disputeId: string) {
    await this.locked(merchantId, disputeId, async (tx, row) => {
      if (!row || row.state === 'cerrado') return;
      const now = new Date();
      if (row.state === 'en_conciliacion' && now >= row.conciliationDeadline) {
        await this.transition(
          tx,
          row,
          'sin_acuerdo',
          'CONCILIATOR',
          'CONCILIATION_DEADLINE_REACHED',
        );
        await this.notice(
          tx,
          row,
          'no-agreement',
          `Conciliación vencida sin acuerdo. Cualquiera puede presentar DEMANDA hasta ${row.claimDeadline.toISOString()}.`,
        );
      }
      if (row.state === 'sin_acuerdo' && now >= row.claimDeadline) {
        await this.transition(
          tx,
          row,
          'cerrado',
          'EVALUATOR',
          'CLAIM_WINDOW_EXPIRED',
        );
        await this.notice(
          tx,
          row,
          'closed-no-claim',
          'Cerró el plazo interno sin demanda. El estado oficial y cualquier decisión financiera corresponden a PayPal.',
        );
      }
      if (
        now >= row.paypalDeadline &&
        !['cerrado', 'escalado_a_paypal'].includes(row.state)
      )
        await this.human(tx, row, 'PAYPAL_DEADLINE_EXPIRED');
    });
  }
  async expireDue(merchantId: string) {
    const due = await this.prisma.mediationCase.findMany({
      where: {
        merchantId,
        OR: [
          {
            state: 'en_conciliacion',
            conciliationDeadline: { lte: new Date() },
          },
          { state: 'sin_acuerdo', claimDeadline: { lte: new Date() } },
        ],
      },
      select: { disputeId: true },
      take: 1000,
    });
    for (const row of due) await this.expire(merchantId, row.disputeId);
  }
  async flushMessages(merchantId: string, disputeId: string) {
    const ctx = await this.context(merchantId, disputeId, true);
    if (!this.paypal.can(ctx.detail!, 'send-message')) return;
    const acquired = await this.locked(merchantId, disputeId, async (tx) => {
      if (
        await tx.mediationMessage.count({
          where: {
            merchantId,
            disputeId,
            status: { in: ['SENDING', 'UNCERTAIN'] },
          },
        })
      )
        return [];
      const queued = await tx.mediationMessage.findMany({
        where: { merchantId, disputeId, status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
        take: 1,
      });
      for (const m of queued) {
        await tx.mediationAction.create({
          data: {
            merchantId,
            disputeId,
            key: `dispatch:${m.id}`,
            hash: m.requestHash,
          },
        });
        await tx.mediationMessage.update({
          where: { id: m.id },
          data: { status: 'SENDING' },
        });
      }
      return queued;
    });
    for (const m of acquired) {
      try {
        const fresh = await this.paypal.detail(
          merchantId,
          ctx.dispute.paypalDisputeId,
        );
        await this.paypal.perform(
          merchantId,
          fresh,
          'send-message',
          { message: m.text },
          m.id,
        );
        await this.locked(merchantId, disputeId, async (tx, row) => {
          await tx.mediationMessage.update({
            where: { id: m.id },
            data: { status: 'SENT' },
          });
          if (m.kind === 'AGREEMENT' && row?.state === 'acuerdo')
            await this.transition(
              tx,
              row,
              'cerrado',
              'CONCILIATOR',
              'AGREEMENT_NOTIFIED_TO_PAYPAL_AND_PARTIES',
            );
        });
      } catch {
        await this.prisma.mediationMessage.update({
          where: { id: m.id },
          data: { status: 'UNCERTAIN' },
        });
        // Every acquired message stays reserved; sync reconciles before any resend.
        return;
      }
    }
  }
  private paypalSourceHash(
    detail: PayPalMediationDetail,
    agentTexts: string[],
  ) {
    return contentHash({
      messages: detail.messages.filter(
        (m) => m.posted_by !== 'SELLER' || !agentTexts.includes(m.content),
      ),
      evidence: detail.evidences,
      supporting: detail.supporting_info,
    });
  }
  async submit(
    merchantId: string,
    disputeId: string,
    explicitlyApproved = false,
  ) {
    const ctx = await this.context(merchantId, disputeId, true);
    const row = await this.prisma.mediationCase.findFirst({
      where: { merchantId, disputeId },
    });
    if (!row || row.state !== 'dictaminado' || row.humanReviewReason) return;
    const policy = MediationPolicySchema.parse(row.policy);
    const authorization = await this.policy(merchantId);
    if (
      !explicitlyApproved &&
      (!policy.automaticSubmission ||
        !authorization?.enabled ||
        !authorization.automaticSubmission)
    )
      return;
    await this.merchants.assertActionAllowed(merchantId, 'SUBMIT');
    if (
      !row.verdict ||
      !row.packet ||
      !row.evidenceRevision ||
      row.evidenceRevision !== ctx.snapshot.dossier.revision ||
      row.paypalDeadline <= new Date()
    )
      throw new ApiException(
        'MEDIATION_PACKET_STALE',
        'A complete current verified packet is required',
        409,
      );
    const fingerprint = await this.prisma.mediationAction.findUnique({
      where: {
        merchantId_disputeId_key: { merchantId, disputeId, key: 'packet-hash' },
      },
    });
    if (
      !fingerprint ||
      fingerprint.hash !== contentHash(row.packet) ||
      contentHash((row.packet as { verdict?: unknown }).verdict) !==
        contentHash(row.verdict)
    )
      throw new ApiException(
        'MEDIATION_PACKET_INTEGRITY_INVALID',
        'The verified dossier integrity check failed',
        409,
      );
    const agentTexts = await this.prisma.mediationMessage.findMany({
      where: { merchantId, disputeId, author: 'AGENT' },
      select: { text: true },
    });
    if (
      (row.packet as { paypalSourceHash?: string }).paypalSourceHash !==
      this.paypalSourceHash(
        ctx.detail!,
        agentTexts.map((m) => m.text),
      )
    )
      throw new ApiException(
        'MEDIATION_PACKET_STALE',
        'PayPal evidence changed after independent review',
        409,
      );
    MediationVerdictSchema.parse(row.verdict);
    const packet = JSON.stringify(row.packet, null, 2);
    if (Buffer.byteLength(packet) > 256 * 1024)
      throw new ApiException(
        'MEDIATION_PACKET_LIMIT',
        'The packet exceeds the submission limit',
        413,
      );
    const delivery = await this.locked(
      merchantId,
      disputeId,
      async (tx, current) => {
        if (
          !current ||
          current.state !== 'dictaminado' ||
          current.humanReviewReason
        )
          return null;
        const existing = await tx.mediationDelivery.findUnique({
          where: { caseId: row.id },
        });
        if (existing) return null;
        return tx.mediationDelivery.create({
          data: {
            caseId: row.id,
            status: 'SENDING',
            payloadHash: contentHash(row.packet),
          },
        });
      },
    );
    if (!delivery) return;
    try {
      let detail = ctx.detail!;
      const form = new FormData();
      const documents: { name: string }[] = [{ name: 'mediation-dossier.pdf' }];
      form.append(
        'mediation-dossier.pdf',
        new Blob([new Uint8Array(dossierPdf(row.packet))], {
          type: 'application/pdf',
        }),
        'mediation-dossier.pdf',
      );
      const originals = ctx.snapshot.dossier.items.filter(
        (i) => i.type === 'DOCUMENT',
      );
      if (originals.length > 9)
        throw new ApiException(
          'MEDIATION_DOCUMENT_LIMIT',
          'The complete dossier exceeds the PayPal document count limit',
          409,
        );
      for (const item of originals) {
        const original = await this.transactions.downloadEvidenceFile(
          merchantId,
          row.transactionId,
          item.id,
        );
        const extension =
          original.mediaType === 'application/pdf'
            ? 'pdf'
            : original.mediaType === 'image/png'
              ? 'png'
              : 'jpg';
        const name = `${item.id}.${extension}`;
        documents.push({ name });
        form.append(
          name,
          new Blob([new Uint8Array(original.bytes)], {
            type: original.mediaType,
          }),
          name,
        );
      }
      const remoteFiles = z
        .array(
          z.object({ reference: z.url(), sha256: z.string(), id: z.string() }),
        )
        .max(9)
        .parse((row.packet as { paypalFiles?: unknown }).paypalFiles ?? []);
      for (const metadata of remoteFiles) {
        const file = await this.paypal.document(
          merchantId,
          ctx.dispute.paypalDisputeId,
          metadata.reference,
        );
        if (file.sha256 !== metadata.sha256)
          throw new ApiException(
            'MEDIATION_PACKET_INTEGRITY_INVALID',
            'PayPal original changed after verification',
            409,
          );
        const extension =
          file.mediaType === 'application/pdf'
            ? 'pdf'
            : file.mediaType === 'image/png'
              ? 'png'
              : 'jpg';
        const name = `paypal-${file.sha256}.${extension}`;
        documents.push({ name });
        form.append(
          name,
          new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }),
          name,
        );
      }
      if (documents.length > 10)
        throw new ApiException(
          'MEDIATION_DOCUMENT_LIMIT',
          'The complete dossier exceeds the PayPal document count limit',
          409,
        );
      if (this.paypal.can(detail, 'provide-evidence')) {
        form.append(
          'input',
          JSON.stringify({
            evidences: [
              {
                evidence_type: 'OTHER',
                notes:
                  'Expediente de mediación íntegro, incluida evidencia favorable y desfavorable. La decisión financiera corresponde a PayPal.',
                documents,
              },
            ],
          }),
        );
        await this.paypal.perform(
          merchantId,
          detail,
          'provide-evidence',
          form,
          delivery.id,
        );
      } else if (this.paypal.can(detail, 'provide-supporting-info')) {
        form.append(
          'input',
          JSON.stringify({
            notes:
              'Expediente de mediación completo adjunto. La decisión financiera corresponde a PayPal.',
          }),
        );
        await this.paypal.perform(
          merchantId,
          detail,
          'provide-supporting-info',
          form,
          delivery.id,
        );
      } else
        throw new ApiException(
          'PAYPAL_ACTION_UNAVAILABLE',
          'PayPal does not permit a dossier submission now',
          409,
        );
      await this.prisma.mediationDelivery.update({
        where: { id: delivery.id },
        data: { phase: 'ESCALATION' },
      });
      detail = await this.paypal.detail(
        merchantId,
        ctx.dispute.paypalDisputeId,
      );
      if (detail.dispute_life_cycle_stage === 'INQUIRY')
        await this.paypal.perform(
          merchantId,
          detail,
          'escalate',
          {
            note: 'Sin acuerdo tras mediación voluntaria. Se aportó expediente con pruebas y dictamen interno. Solicitamos gestión de PayPal.',
          },
          `${delivery.id}-escalate`,
        );
      await this.locked(merchantId, disputeId, async (tx, current) => {
        await tx.mediationDelivery.update({
          where: { id: delivery.id },
          data: { status: 'SENT', phase: 'COMPLETE' },
        });
        if (current?.state === 'dictaminado')
          await this.transition(
            tx,
            current,
            'escalado_a_paypal',
            'EVALUATOR',
            'PAYPAL_ACKNOWLEDGED_DOSSIER',
          );
      });
    } catch {
      await this.locked(merchantId, disputeId, async (tx, current) => {
        await tx.mediationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'UNCERTAIN',
            errorCode: 'PAYPAL_DELIVERY_REQUIRES_RECONCILIATION',
          },
        });
        if (current)
          await this.human(
            tx,
            current,
            'PAYPAL_DELIVERY_REQUIRES_RECONCILIATION',
          );
      });
    }
  }
  async tick(merchantId: string) {
    const policy = await this.policy(merchantId);
    if (!policy?.enabled) return;
    let page = 1,
      pages = 1;
    while (page <= pages) {
      const listed = await this.disputes.list(merchantId, {
        page,
        pageSize: 100,
        internalState: 'LINKED',
      });
      pages = Math.ceil(listed.total / 100);
      const known = await this.prisma.mediationCase.findMany({
        where: { merchantId, disputeId: { in: listed.items.map((d) => d.id) } },
        select: { disputeId: true },
      });
      for (const dispute of listed.items) {
        if (
          known.some((c) => c.disputeId === dispute.id) ||
          dispute.paypalStage !== 'INQUIRY' ||
          dispute.paypalStatus === 'RESOLVED'
        )
          continue;
        try {
          await this.ensureCase(merchantId, dispute.id, 'auto');
        } catch {
          /* No fictional case when identity, policy or PayPal time is missing. */
        }
      }
      page++;
    }
    const active = await this.prisma.mediationCase.findMany({
      where: {
        merchantId,
        state: { not: 'cerrado' },
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: 100,
    });
    for (const row of active) {
      try {
        await this.sync(merchantId, row.disputeId);
        await this.expire(merchantId, row.disputeId);
        if (!row.humanReviewReason)
          await this.advance(merchantId, row.disputeId);
        await this.flushMessages(merchantId, row.disputeId);
      } catch {
        await this.locked(merchantId, row.disputeId, async (tx, current) => {
          if (!current) return;
          const failures = current.failures + 1;
          await tx.mediationCase.update({
            where: { id: current.id },
            data: { failures },
          });
          if (failures >= 3 && !current.humanReviewReason)
            await this.human(tx, current, 'PAYPAL_READ_FAILED');
        });
      } finally {
        await this.prisma.mediationCase.updateMany({
          where: { id: row.id, nextAttemptAt: { lte: new Date() } },
          data: { nextAttemptAt: new Date(Date.now() + 30000) },
        });
      }
    }
  }
}
