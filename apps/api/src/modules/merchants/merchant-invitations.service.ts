import {
  Inject,
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import {
  MerchantInvitationSchema,
  MerchantResponseSchema,
  type CreateMerchantInvitation,
} from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import type {
  Prisma,
  MerchantInvitation,
  Merchant,
} from '../../generated/prisma/client.js';
import type { MerchantActor } from './auth/merchant-access.guard.js';
import { InvitationMailer, InvitationMailError } from './invitation-mailer.js';
import { AuditService } from '../monitoring/audit.service.js';

type Identity = { userId: string; email: string };
type InvitationWithTeam = MerchantInvitation & { merchant: Merchant };
@Injectable()
export class MerchantInvitationsService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(MerchantInvitationsService.name);
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(InvitationMailer) private readonly mailer: InvitationMailer,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  onModuleInit() {
    if (this.env.INVITATION_EMAIL_WORKER_ENABLED && this.mailer.configured) {
      this.timer = setInterval(() => {
        void this.deliverNext().catch(() =>
          this.logger.error('INVITATION_EMAIL_WORKER_FAILED'),
        );
      }, 1000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private url(id: string) {
    const origin = this.env.INVITATION_APP_URL ?? this.env.CORS_ORIGIN[0]!;
    const url = new URL(origin);
    if (
      !this.env.CORS_ORIGIN.includes(url.origin) ||
      url.username ||
      url.password ||
      (this.env.NODE_ENV === 'production' && url.protocol !== 'https:')
    )
      throw new ApiException(
        'INVITATION_URL_NOT_CONFIGURED',
        'Configure an authorized frontend origin for invitations',
        503,
      );
    return new URL(`/?teamInvitation=${id}`, url.origin).href;
  }
  private present(row: InvitationWithTeam) {
    return MerchantInvitationSchema.parse({
      ...row,
      displayName: row.merchant.displayName,
      status:
        row.status === 'PENDING' && row.expiresAt <= new Date()
          ? 'EXPIRED'
          : row.status,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      emailSentAt: row.emailSentAt?.toISOString() ?? null,
      shareUrl: this.url(row.id),
    });
  }
  private async lock(tx: Prisma.TransactionClient, merchantId: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`team-invitations:${merchantId}`},0))::text`;
  }
  private async admin(tx: Prisma.TransactionClient, actor: MerchantActor) {
    const member = await tx.merchantMember.findFirst({
      where: {
        merchantId: actor.merchantId,
        authUserId: actor.userId,
        active: true,
        role: 'ADMIN',
      },
    });
    if (!member)
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'An active team administrator is required',
        403,
      );
  }
  private async event(
    tx: Prisma.TransactionClient,
    merchantId: string,
    userId: string,
    event: 'CREATED' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EMAIL_REQUESTED',
    invitationId: string,
  ) {
    await tx.merchantEvent.create({
      data: {
        merchantId,
        actorUserId: userId,
        action: `TEAM_INVITATION_${event}`,
        details: { invitationId },
      },
    });
    await this.audit.append(
      {
        merchantId,
        actorUserId: userId,
        resourceType: 'MERCHANT',
        resourceId: merchantId,
        record: {
          action: 'TEAM_INVITATION_EVENT',
          details: { event, invitationId },
        },
      },
      tx,
    );
  }
  async listAdmin(actor: MerchantActor) {
    return this.db.$transaction(async (tx) => {
      await this.admin(tx, actor);
      const rows = await tx.merchantInvitation.findMany({
        where: { merchantId: actor.merchantId },
        include: { merchant: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      return { items: rows.map((row) => this.present(row)) };
    });
  }
  async list(identity: Identity) {
    const rows = await this.db.merchantInvitation.findMany({
      where: {
        email: identity.email,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      include: { merchant: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { items: rows.map((row) => this.present(row)) };
  }
  async detail(identity: Identity, id: string) {
    const row = await this.db.merchantInvitation.findFirst({
      where: { id, email: identity.email },
      include: { merchant: true },
    });
    if (!row)
      throw new ApiException(
        'INVITATION_NOT_FOUND',
        'Invitation not found for your verified email',
        404,
      );
    return this.present(row);
  }
  async create(
    actor: MerchantActor,
    identity: Identity,
    input: CreateMerchantInvitation,
  ) {
    if (identity.email === input.email)
      throw new ApiException(
        'SELF_INVITATION',
        'You already belong to this team',
        409,
      );
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, actor.merchantId);
      await this.admin(tx, actor);
      const now = new Date();
      await tx.merchantInvitation.updateMany({
        where: {
          merchantId: actor.merchantId,
          status: 'PENDING',
          expiresAt: { lte: now },
        },
        data: { status: 'EXPIRED' },
      });
      if (
        await tx.merchantInvitation.findFirst({
          where: {
            merchantId: actor.merchantId,
            email: input.email,
            status: 'PENDING',
          },
        })
      )
        throw new ApiException(
          'INVITATION_EXISTS',
          'A pending invitation already exists for this email',
          409,
        );
      const count = await tx.merchantInvitation.count({
        where: {
          merchantId: actor.merchantId,
          createdAt: { gte: new Date(now.getTime() - 3600000) },
        },
      });
      const pending = await tx.merchantInvitation.count({
        where: { merchantId: actor.merchantId, status: 'PENDING' },
      });
      if (count >= 30 || pending >= 100)
        throw new ApiException(
          'INVITATION_RATE_LIMIT',
          'Team invitation limit reached. Try again later',
          429,
        );
      const row = await tx.merchantInvitation.create({
        data: {
          merchantId: actor.merchantId,
          email: input.email,
          role: input.role,
          createdBy: actor.userId,
          expiresAt: new Date(now.getTime() + 7 * 86400000),
          deliveryStatus: this.mailer.configured ? 'PENDING' : 'NOT_CONFIGURED',
        },
        include: { merchant: true },
      });
      await this.event(tx, actor.merchantId, actor.userId, 'CREATED', row.id);
      return this.present(row);
    });
  }
  async respond(identity: Identity, id: string, action: 'accept' | 'decline') {
    return this.db.$transaction(async (tx) => {
      const first = await tx.merchantInvitation.findFirst({
        where: { id, email: identity.email },
      });
      if (!first)
        throw new ApiException(
          'INVITATION_NOT_FOUND',
          'Invitation not found for your verified email',
          404,
        );
      await this.lock(tx, first.merchantId);
      const row = await tx.merchantInvitation.findUniqueOrThrow({
        where: { id },
        include: { merchant: true },
      });
      const existing = await tx.merchantMember.findUnique({
        where: {
          merchantId_authUserId: {
            merchantId: row.merchantId,
            authUserId: identity.userId,
          },
        },
      });
      if (
        action === 'accept' &&
        row.status === 'ACCEPTED' &&
        row.acceptedBy === identity.userId &&
        existing?.active
      )
        return MerchantResponseSchema.parse({
          ...row.merchant,
          role: existing.role,
          policy: row.merchant,
        });
      if (action === 'decline' && row.status === 'DECLINED')
        return this.present(row);
      if (row.status !== 'PENDING')
        throw new ApiException(
          'INVITATION_INACTIVE',
          'This invitation is no longer pending',
          409,
        );
      if (row.expiresAt <= new Date())
        throw new ApiException(
          'INVITATION_EXPIRED',
          'This invitation has expired',
          410,
        );
      if (action === 'decline') {
        const updated = await tx.merchantInvitation.update({
          where: { id },
          data: { status: 'DECLINED' },
          include: { merchant: true },
        });
        await this.event(tx, row.merchantId, identity.userId, 'DECLINED', id);
        return this.present(updated);
      }
      await this.admin(tx, {
        merchantId: row.merchantId,
        userId: row.createdBy,
        role: 'ADMIN',
      });
      const member = existing?.active
        ? existing
        : await tx.merchantMember.upsert({
            where: {
              merchantId_authUserId: {
                merchantId: row.merchantId,
                authUserId: identity.userId,
              },
            },
            create: {
              merchantId: row.merchantId,
              authUserId: identity.userId,
              role: row.role,
            },
            update: { active: true, role: row.role },
          });
      await tx.merchantInvitation.update({
        where: { id },
        data: {
          status: 'ACCEPTED',
          acceptedBy: identity.userId,
          acceptedAt: new Date(),
        },
      });
      await this.event(tx, row.merchantId, identity.userId, 'ACCEPTED', id);
      return MerchantResponseSchema.parse({
        ...row.merchant,
        role: member.role,
        policy: row.merchant,
      });
    });
  }
  async manage(actor: MerchantActor, id: string, action: 'revoke' | 'resend') {
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, actor.merchantId);
      await this.admin(tx, actor);
      const row = await tx.merchantInvitation.findFirst({
        where: { id, merchantId: actor.merchantId },
      });
      if (!row)
        throw new ApiException(
          'INVITATION_NOT_FOUND',
          'Invitation not found',
          404,
        );
      if (action === 'revoke' && row.status === 'REVOKED')
        return this.present({
          ...row,
          merchant: await tx.merchant.findUniqueOrThrow({
            where: { id: actor.merchantId },
          }),
        });
      if (row.status !== 'PENDING' || row.expiresAt <= new Date())
        throw new ApiException(
          'INVITATION_INACTIVE',
          'This invitation is no longer pending',
          409,
        );
      if (
        action === 'resend' &&
        (row.deliveryStatus === 'PROCESSING' ||
          Date.now() - row.updatedAt.getTime() < 60000)
      )
        throw new ApiException(
          'INVITATION_RESEND_LIMIT',
          'Wait at least one minute before resending',
          429,
        );
      if (
        action === 'resend' &&
        (await tx.merchantEvent.count({
          where: {
            merchantId: actor.merchantId,
            action: 'TEAM_INVITATION_EMAIL_REQUESTED',
            createdAt: { gt: new Date(Date.now() - 3600000) },
          },
        })) >= 30
      )
        throw new ApiException(
          'INVITATION_RATE_LIMIT',
          'Email limit reached. Try again later',
          429,
        );
      const updated = await tx.merchantInvitation.update({
        where: { id },
        data:
          action === 'revoke'
            ? { status: 'REVOKED' }
            : {
                deliveryStatus: this.mailer.configured
                  ? 'PENDING'
                  : 'NOT_CONFIGURED',
                emailVersion: { increment: 1 },
                emailAttempts: 0,
                emailSentAt: null,
                emailErrorCode: null,
                nextEmailAttemptAt: null,
                emailLeaseUntil: null,
              },
        include: { merchant: true },
      });
      await this.event(
        tx,
        actor.merchantId,
        actor.userId,
        action === 'revoke' ? 'REVOKED' : 'EMAIL_REQUESTED',
        id,
      );
      return this.present(updated);
    });
  }
  async deliverNext() {
    if (this.running || !this.mailer.configured) return;
    this.running = true;
    try {
      const now = new Date();
      // Resend retains idempotency keys for 24 hours. Never repeat an ambiguous
      // attempt outside that window, or leave exhausted leases queued forever.
      await this.db.merchantInvitation.updateMany({
        where: {
          deliveryStatus: { in: ['PENDING', 'PROCESSING'] },
          emailAttempts: { gt: 0 },
          updatedAt: { lt: new Date(now.getTime() - 23 * 3600000) },
        },
        data: {
          deliveryStatus: 'UNCERTAIN',
          emailErrorCode: 'EMAIL_IDEMPOTENCY_WINDOW_EXPIRED',
          emailLeaseUntil: null,
        },
      });
      await this.db.merchantInvitation.updateMany({
        where: {
          deliveryStatus: 'PROCESSING',
          emailLeaseUntil: { lt: now },
          emailAttempts: { gte: 5 },
        },
        data: {
          deliveryStatus: 'UNCERTAIN',
          emailErrorCode: 'EMAIL_ATTEMPTS_EXHAUSTED',
          emailLeaseUntil: null,
        },
      });
      await this.db.merchantInvitation.updateMany({
        where: { deliveryStatus: 'PROCESSING', emailLeaseUntil: { lt: now } },
        data: {
          deliveryStatus: this.mailer.retrySafe ? 'PENDING' : 'UNCERTAIN',
          emailErrorCode: 'EMAIL_LEASE_EXPIRED',
          emailLeaseUntil: null,
        },
      });
      const row = await this.db.merchantInvitation.findFirst({
        where: {
          status: 'PENDING',
          expiresAt: { gt: now },
          deliveryStatus: 'PENDING',
          emailAttempts: { lt: 5 },
          OR: [
            { nextEmailAttemptAt: null },
            { nextEmailAttemptAt: { lte: now } },
          ],
        },
        include: { merchant: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!row) return;
      const claimed = await this.db.merchantInvitation.updateMany({
        where: {
          id: row.id,
          emailVersion: row.emailVersion,
          deliveryStatus: 'PENDING',
          status: 'PENDING',
        },
        data: {
          deliveryStatus: 'PROCESSING',
          emailAttempts: { increment: 1 },
          emailLeaseUntil: new Date(Date.now() + 60000),
        },
      });
      if (!claimed.count) return;
      const inviter = await this.db.merchantMember.findFirst({
        where: {
          merchantId: row.merchantId,
          authUserId: row.createdBy,
          role: 'ADMIN',
          active: true,
        },
      });
      let status = 'SENT',
        code: string | null = null;
      try {
        if (!inviter) throw new InvitationMailError('INVITER_INACTIVE');
        await this.mailer.send({
          id: row.id,
          version: row.emailVersion,
          email: row.email,
          team: row.merchant.displayName,
          role: row.role,
          url: this.url(row.id),
        });
      } catch (error) {
        code =
          error instanceof InvitationMailError
            ? error.code
            : 'EMAIL_DELIVERY_FAILED';
        status =
          error instanceof InvitationMailError && error.uncertain
            ? 'UNCERTAIN'
            : this.mailer.retrySafe &&
                row.emailAttempts < 4 &&
                code !== 'INVITER_INACTIVE'
              ? 'PENDING'
              : 'FAILED';
      }
      await this.db.merchantInvitation.updateMany({
        where: {
          id: row.id,
          emailVersion: row.emailVersion,
          deliveryStatus: 'PROCESSING',
        },
        data: {
          deliveryStatus: status,
          emailErrorCode: code,
          emailSentAt: status === 'SENT' ? new Date() : null,
          emailLeaseUntil: null,
          nextEmailAttemptAt:
            status === 'PENDING'
              ? new Date(Date.now() + 60000 * 2 ** row.emailAttempts)
              : null,
        },
      });
    } finally {
      this.running = false;
    }
  }
}
