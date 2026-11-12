import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { MonitoringModule } from '../monitoring/index.js';
import { AuditModule } from '../monitoring/audit.module.js';
import { SubmissionsController } from './submissions.controller.js';
import { SubmissionsService } from './submissions.service.js';
import { MediationPayPalClient } from './mediation-paypal.client.js';

@Module({
  imports: [MerchantsModule, MonitoringModule, AuditModule],
  controllers: [SubmissionsController],
  providers: [SubmissionsService, MediationPayPalClient],
  exports: [SubmissionsService, MediationPayPalClient],
})
export class SubmissionsModule {}
