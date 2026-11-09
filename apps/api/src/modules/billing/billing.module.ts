import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { AuditModule } from '../monitoring/audit.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

@Module({
  imports: [MerchantsModule, AuditModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
