import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MerchantAccessGuard, type MerchantActor } from '../merchants/index.js';
import { DashboardOptimizedService } from './dashboard-optimized.service.js';

@ApiTags('monitoring')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
@Controller('dashboard')
export class DashboardOptimizedController {
  constructor(
    @Inject(DashboardOptimizedService)
    private readonly dashboard: DashboardOptimizedService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get complete dashboard data in a single optimized query',
  })
  async getDashboard(@Req() req: { merchantActor: MerchantActor }) {
    return this.dashboard.getDashboardData(req.merchantActor.merchantId);
  }
}
