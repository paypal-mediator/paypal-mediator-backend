import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  ActivityQuerySchema,
  ActivityResponseSchema,
  MonitoringMetricsQuerySchema,
  MonitoringMetricsResponseSchema,
  type ActivityQuery,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import {
  MerchantAccessGuard,
  type MerchantRequest,
} from '../merchants/index.js';
import { MonitoringService } from './monitoring.service.js';

@ApiTags('monitoring')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
@Controller('activity')
export class MonitoringController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MonitoringService) private readonly monitoring: MonitoringService,
  ) {}

  @Get('metrics')
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(MonitoringMetricsResponseSchema),
  })
  metrics(
    @Req() req: MerchantRequest,
    @Query(new ZodValidationPipe(MonitoringMetricsQuerySchema))
    query: { hours: number },
  ) {
    return this.monitoring.metrics(req.merchantActor.merchantId, query.hours);
  }

  @Get()
  @ApiResponse({ status: 200, schema: zodOpenApi(ActivityResponseSchema) })
  async list(
    @Req() req: MerchantRequest,
    @Query(new ZodValidationPipe(ActivityQuerySchema)) query: ActivityQuery,
  ) {
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        merchantId: req.merchantActor.merchantId,
        ...(query.module ? { module: query.module } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.transactionId ? { transactionId: query.transactionId } : {}),
        ...(query.resourceId ? { resourceId: query.resourceId } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
        AND: [
          ...(query.from ? [{ createdAt: { gte: new Date(query.from) } }] : []),
          ...(query.to ? [{ createdAt: { lte: new Date(query.to) } }] : []),
        ],
        ...(query.before && query.beforeId
          ? {
              OR: [
                { createdAt: { lt: new Date(query.before) } },
                {
                  createdAt: new Date(query.before),
                  id: { lt: query.beforeId },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const items = rows
      .slice(0, query.limit)
      .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    const last = items.at(-1);
    return ActivityResponseSchema.parse({
      items,
      nextCursor:
        rows.length > query.limit && last
          ? { before: last.createdAt, beforeId: last.id }
          : null,
    });
  }
}
