import { Inject, Injectable } from '@nestjs/common';
import {
  CreateOrderSchema,
  type CreateOrder,
  type OrderQuery,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiException } from '../../common/http/api.exception.js';
import { contentHash } from '../../common/data/content-hash.js';
import { EvidenceService } from '../evidence/index.js';
import type { MerchantActor } from '../merchants/index.js';
import { AuditService } from '../monitoring/audit.service.js';
import { lockMerchantOrders, reconcileOrder } from './order-linking.js';
import {
  evidenceContext,
  normalizeOrder,
  orderResponse,
} from './order-mapping.js';

const Money = Prisma.Decimal.clone({ precision: 64 });

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EvidenceService) private readonly evidence: EvidenceService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(actor: MerchantActor, input: CreateOrder) {
    const parsed = CreateOrderSchema.parse(input);
    const normalized = normalizeOrder(parsed);
    const subtotal = parsed.items.reduce(
      (sum, item) => sum.plus(new Money(item.unitAmount).times(item.quantity)),
      new Money(0),
    );
    const calculated = subtotal
      .plus(parsed.shippingAmount)
      .plus(parsed.taxAmount)
      .minus(parsed.discountAmount);
    if (!calculated.equals(parsed.totalAmount))
      throw new ApiException(
        'ORDER_TOTAL_MISMATCH',
        'Order total does not match its items and adjustments',
        400,
      );
    if (Date.parse(parsed.orderedAt) > Date.now() + 300000)
      throw new ApiException(
        'ORDER_DATE_INVALID',
        'Order date cannot be in the future',
        400,
      );
    const hash = contentHash(normalized);
    return this.prisma.$transaction(
      async (tx) => {
        await lockMerchantOrders(tx, actor.merchantId);
        const existing = await tx.merchantOrder.findFirst({
          where: {
            merchantId: actor.merchantId,
            environment: 'sandbox',
            OR: [
              { externalId: parsed.externalId },
              ...(parsed.paypalOrderId
                ? [{ paypalOrderId: parsed.paypalOrderId }]
                : []),
            ],
          },
        });
        if (existing && existing.contentHash !== hash)
          throw new ApiException(
            'ORDER_CONFLICT',
            'This order reference already has different content',
            409,
          );
        const order =
          existing ??
          (await tx.merchantOrder.create({
            data: {
              ...normalized,
              orderedAt: new Date(normalized.orderedAt),
              items: normalized.items as Prisma.InputJsonValue,
              merchantId: actor.merchantId,
              createdBy: actor.userId,
              contentHash: hash,
            },
          }));
        const captures = await tx.transaction.findMany({
          where: {
            merchantId: actor.merchantId,
            OR: [
              { merchantOrderReference: order.externalId },
              ...(order.paypalOrderId
                ? [{ paypalOrderId: order.paypalOrderId }]
                : []),
            ],
          },
          orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
        });
        for (const capture of captures) {
          const linked = await reconcileOrder(tx, capture);
          await this.evidence.syncBase(tx, evidenceContext(linked));
        }
        if (!existing)
          await this.audit.append(
            {
              merchantId: actor.merchantId,
              actorUserId: actor.userId,
              resourceType: 'ORDER',
              resourceId: order.id,
              record: {
                action: 'ORDER_CREATED',
                details: { sourceKind: parsed.sourceKind },
              },
            },
            tx,
          );
        return {
          outcome: existing ? ('DUPLICATE' as const) : ('CREATED' as const),
          order: orderResponse(order),
        };
      },
      { timeout: 15000 },
    );
  }

  async list(merchantId: string, query: OrderQuery) {
    const where = {
      merchantId,
      ...(query.externalId ? { externalId: query.externalId } : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.merchantOrder.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        this.prisma.merchantOrder.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      items: items.map(orderResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(merchantId: string, id: string) {
    const order = await this.prisma.merchantOrder.findFirst({
      where: { id, merchantId },
    });
    if (!order)
      throw new ApiException('ORDER_NOT_FOUND', 'Order not found', 404);
    return orderResponse(order);
  }
}
