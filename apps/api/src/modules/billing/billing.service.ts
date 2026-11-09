import { Inject, Injectable } from '@nestjs/common';
import {
  PlanResponseSchema,
  SubscriptionResponseSchema,
  type PlanResponse,
  type SubscriptionResponse,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import { AuditService } from '../monitoring/audit.service.js';

@Injectable()
export class BillingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async getPlans(): Promise<PlanResponse[]> {
    const plans = await this.prisma.plan.findMany({
      where: { active: true },
      orderBy: { priceCents: 'asc' },
    });
    return plans.map((plan) => PlanResponseSchema.parse(plan));
  }

  async getSubscription(
    merchantId: string,
  ): Promise<SubscriptionResponse | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { merchantId, status: 'ACTIVE' },
      include: { plan: true },
    });
    if (!subscription) return null;
    return SubscriptionResponseSchema.parse(subscription);
  }

  async createSubscription(
    merchantId: string,
    planId: string,
    actorUserId: string,
  ): Promise<SubscriptionResponse> {
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
    });
    if (!plan || !plan.active) {
      throw new ApiException(
        'PLAN_NOT_FOUND',
        'The requested plan does not exist or is not active',
        404,
      );
    }

    const existing = await this.prisma.subscription.findFirst({
      where: { merchantId, status: 'ACTIVE' },
    });
    if (existing) {
      throw new ApiException(
        'SUBSCRIPTION_ALREADY_ACTIVE',
        'The merchant already has an active subscription',
        409,
      );
    }

    const currentPeriodEnd = new Date();
    currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);

    const subscription = await this.prisma.$transaction(async (tx) => {
      const created = await tx.subscription.create({
        data: {
          merchantId,
          planId,
          status: 'ACTIVE',
          currentPeriodEnd,
        },
        include: { plan: true },
      });
      await this.audit.append(
        {
          merchantId,
          actorUserId,
          resourceType: 'SUBSCRIPTION',
          resourceId: created.id,
          record: {
            action: 'SUBSCRIPTION_CREATED',
            details: { planId },
          },
        },
        tx,
      );
      return created;
    });

    return SubscriptionResponseSchema.parse(subscription);
  }
}
