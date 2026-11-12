import { Inject, Injectable } from '@nestjs/common';
import {
  IntegrationsResponseSchema,
  MerchantListResponseSchema,
  MerchantPolicySchema,
  MerchantResponseSchema,
  type IntegrationsResponse,
  type MerchantListResponse,
  type MerchantPolicy,
  type MerchantResponse,
  type UpdateMerchantSettings,
  type CreateMerchant,
} from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import type { MerchantActor } from './auth/merchant-access.guard.js';
import { PayPalConnectionClient } from './paypal/paypal-connection.client.js';
import { AuditService } from '../monitoring/audit.service.js';
import { z } from 'zod';

@Injectable()
export class MerchantsService {
  private readonly checksInFlight = new Map<
    string,
    Promise<IntegrationsResponse>
  >();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PayPalConnectionClient)
    private readonly paypal: PayPalConnectionClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createMerchant(
    userId: string,
    input: CreateMerchant,
  ): Promise<MerchantResponse> {
    return this.prisma.$transaction(async (tx) => {
      const merchant = await tx.merchant.create({
        data: {
          displayName: input.displayName,
          members: { create: { authUserId: userId, role: 'ADMIN' } },
          events: {
            create: {
              actorUserId: userId,
              action: 'TEAM_CREATED',
              details: {},
            },
          },
        },
      });
      return MerchantResponseSchema.parse({
        ...merchant,
        role: 'ADMIN',
        policy: merchant,
      });
    });
  }

  private async findMerchant(merchantId: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
    });
    if (!merchant)
      throw new ApiException(
        'MERCHANT_NOT_FOUND',
        'The merchant has not been provisioned',
        404,
      );
    return merchant;
  }

  async getMerchant(actor: MerchantActor): Promise<MerchantResponse> {
    const merchant = await this.findMerchant(actor.merchantId);
    return MerchantResponseSchema.parse({
      ...merchant,
      role: actor.role,
      policy: merchant,
    });
  }

  async listMerchants(userId: string): Promise<MerchantListResponse> {
    const members = await this.prisma.merchantMember.findMany({
      where: { authUserId: userId, active: true },
      include: { merchant: true },
      orderBy: { createdAt: 'asc' },
    });
    const items = members.map((member) =>
      MerchantResponseSchema.parse({
        ...member.merchant,
        role: member.role,
        policy: member.merchant,
      }),
    );
    return MerchantListResponseSchema.parse({ items });
  }

  async getPolicy(merchantId: string): Promise<MerchantPolicy> {
    return MerchantPolicySchema.parse(await this.findMerchant(merchantId));
  }

  async getPayPalWebhookContext(
    resource?: Record<string, unknown>,
    eventType?: string,
  ): Promise<{
    merchantId: string;
    webhookId: string;
  }> {
    let merchantId = this.environment.MERCHANT_ID;
    if (resource && this.environment.PAYPAL_PARTNER_MERCHANT_ID) {
      const identity = z
        .object({
          merchant_id: z.string().optional(),
          payee: z.object({ merchant_id: z.string() }).optional(),
          disputed_transactions: z
            .array(
              z.object({
                seller: z.object({ merchant_id: z.string() }).optional(),
              }),
            )
            .optional(),
        })
        .safeParse(resource);
      if (!identity.success)
        throw new ApiException(
          'PAYPAL_WEBHOOK_MERCHANT_UNKNOWN',
          'Webhook seller identity is invalid',
          422,
        );
      const sellers = [
        ...new Set(
          [
            identity.data.merchant_id,
            identity.data.payee?.merchant_id,
            ...(identity.data.disputed_transactions ?? []).map(
              (t) => t.seller?.merchant_id,
            ),
          ].filter((id): id is string => Boolean(id)),
        ),
      ];
      if (sellers.length !== 1)
        throw new ApiException(
          'PAYPAL_WEBHOOK_MERCHANT_UNKNOWN',
          'Webhook must identify exactly one connected PayPal seller',
          422,
        );
      const account = await this.prisma.payPalAccount.findUnique({
        where: { sellerId: sellers[0] },
      });
      if (
        !account ||
        (account.status !== 'CONNECTED' &&
          eventType !== 'MERCHANT.PARTNER-CONSENT.REVOKED')
      )
        throw new ApiException(
          'PAYPAL_WEBHOOK_MERCHANT_UNKNOWN',
          'Webhook seller is not connected',
          422,
        );
      merchantId = account.merchantId;
    }
    const webhookId = this.environment.PAYPAL_WEBHOOK_ID;
    if (!merchantId || !webhookId || !this.paypal.credentialsConfigured) {
      throw new ApiException(
        'WEBHOOK_NOT_CONFIGURED',
        'The Sandbox webhook integration is not configured',
        503,
      );
    }
    await this.findMerchant(merchantId);
    return { merchantId, webhookId };
  }

  async paypalWorkerMerchants(): Promise<string[]> {
    const accounts = await this.prisma.payPalAccount.findMany({
      where: { status: 'CONNECTED' },
      select: { merchantId: true },
    });
    return [
      ...new Set([
        ...accounts.map((account) => account.merchantId),
        ...(this.environment.MERCHANT_ID ? [this.environment.MERCHANT_ID] : []),
      ]),
    ];
  }

  async revokePayPal(merchantId: string) {
    await this.prisma.payPalAccount.updateMany({
      where: { merchantId },
      data: { status: 'DISCONNECTED', expiresAt: new Date(0) },
    });
  }

  async assertActionAllowed(
    merchantId: string,
    action: 'INVESTIGATE' | 'SUBMIT',
  ): Promise<void> {
    const policy = await this.getPolicy(merchantId);
    if (
      action === 'INVESTIGATE'
        ? !policy.allowInvestigations
        : !policy.allowSubmissions
    ) {
      throw new ApiException(
        'MERCHANT_ACTION_DISABLED',
        'The merchant has not authorized this action',
        403,
      );
    }
    // SUBMIT still requires M08 state/evidence/approval checks. This method is only policy authorization.
  }

  async updateSettings(
    actor: MerchantActor,
    settings: UpdateMerchantSettings,
  ): Promise<MerchantResponse> {
    if (actor.role !== 'ADMIN')
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'A merchant administrator is required',
        403,
      );
    const merchant = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.merchant.update({
        where: { id: actor.merchantId },
        data: settings,
      });
      await this.audit.append(
        {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          record: {
            action: 'SETTINGS_UPDATED',
            details: {
              displayNameChanged: settings.displayName !== undefined,
              allowInvestigations: settings.allowInvestigations,
              allowSubmissions: settings.allowSubmissions,
              requireMerchantApproval: settings.requireMerchantApproval,
            },
          },
        },
        tx,
      );
      await tx.merchantEvent.create({
        data: {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          action: 'SETTINGS_UPDATED',
          details: settings,
        },
      });
      return updated;
    });
    return MerchantResponseSchema.parse({
      ...merchant,
      role: actor.role,
      policy: merchant,
    });
  }

  async getIntegrations(merchantId: string): Promise<IntegrationsResponse> {
    await this.findMerchant(merchantId);
    const account = await this.prisma.payPalAccount.findUnique({
      where: { merchantId },
    });
    const stored = await this.prisma.merchantIntegration.findUnique({
      where: { merchantId },
    });
    const configured =
      (account
        ? account.status === 'CONNECTED'
        : merchantId === this.environment.MERCHANT_ID &&
          !this.environment.PAYPAL_PARTNER_MERCHANT_ID) &&
      this.paypal.credentialsConfigured;
    const current =
      configured && stored?.credentialFingerprint === this.paypal.fingerprint
        ? stored
        : null;
    return IntegrationsResponseSchema.parse({
      merchantId,
      paypal: {
        onboardingAvailable: Boolean(
          this.environment.PAYPAL_PARTNER_MERCHANT_ID &&
          this.environment.PAYPAL_ONBOARDING_RETURN_URL &&
          this.paypal.credentialsConfigured,
        ),
        sellerId: account?.sellerId ?? null,
        onboardingStatus: account?.status ?? null,
        provider: 'PAYPAL',
        environment: 'sandbox',
        source: 'PAYPAL_SANDBOX',
        credentialsConfigured: configured,
        webhookConfigured:
          configured && Boolean(this.environment.PAYPAL_WEBHOOK_ID),
        connectionStatus: !configured
          ? 'NOT_CONFIGURED'
          : (current?.connectionStatus ??
            (account?.status === 'CONNECTED' ? 'CONNECTED' : 'NOT_CHECKED')),
        disputesReadStatus: configured
          ? (current?.disputesReadStatus ?? 'NOT_CHECKED')
          : 'NOT_CHECKED',
        lastCheckedAt: current?.lastCheckedAt.toISOString() ?? null,
        paypalHttpStatus: current?.paypalHttpStatus ?? null,
        paypalDebugId: current?.paypalDebugId ?? null,
      },
    });
  }

  async checkPayPal(actor: MerchantActor): Promise<IntegrationsResponse> {
    if (actor.role !== 'ADMIN')
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'A merchant administrator is required',
        403,
      );
    if (
      (!(await this.prisma.payPalAccount.findFirst({
        where: { merchantId: actor.merchantId, status: 'CONNECTED' },
      })) &&
        actor.merchantId !== this.environment.MERCHANT_ID) ||
      !this.paypal.credentialsConfigured
    ) {
      throw new ApiException(
        'PAYPAL_NOT_CONFIGURED',
        'PayPal Sandbox credentials are not configured',
        409,
      );
    }
    const existing = this.checksInFlight.get(actor.merchantId);
    if (existing) return existing;
    const check = this.performCheck(actor);
    this.checksInFlight.set(actor.merchantId, check);
    try {
      return await check;
    } finally {
      this.checksInFlight.delete(actor.merchantId);
    }
  }

  private async performCheck(
    actor: MerchantActor,
  ): Promise<IntegrationsResponse> {
    await this.findMerchant(actor.merchantId);
    const result = await this.paypal.check(actor.merchantId);
    await this.prisma.$transaction(async (tx) => {
      const data = {
        ...result,
        credentialFingerprint: this.paypal.fingerprint,
        lastCheckedAt: new Date(),
      };
      await tx.merchantIntegration.upsert({
        where: { merchantId: actor.merchantId },
        create: { merchantId: actor.merchantId, ...data },
        update: data,
      });
      await tx.merchantEvent.create({
        data: {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          action: 'PAYPAL_CONNECTION_CHECKED',
          details: result,
        },
      });
      await this.audit.append(
        {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          resourceId: actor.merchantId,
          outcome:
            result.connectionStatus === 'CONNECTED' &&
            result.disputesReadStatus === 'AVAILABLE'
              ? 'SUCCEEDED'
              : 'FAILED',
          record: {
            action: 'PAYPAL_CONNECTION_CHECKED',
            details: {
              ...(result.paypalHttpStatus
                ? { httpStatus: result.paypalHttpStatus }
                : {}),
            },
          },
        },
        tx,
      );
    });
    return this.getIntegrations(actor.merchantId);
  }
}
