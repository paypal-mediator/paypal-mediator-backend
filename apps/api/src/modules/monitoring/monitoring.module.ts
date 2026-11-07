import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { AuditModule } from './audit.module.js';
import { MonitoringController } from './monitoring.controller.js';
import { MonitoringService } from './monitoring.service.js';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditFailureInterceptor } from './audit-failure.interceptor.js';
import { EventIngestionModule } from '../event-ingestion/index.js';
import { TransactionsModule } from '../transactions/index.js';
import { InvestigatorModule } from '../investigator/index.js';
import { VerifierModule } from '../verifier/index.js';

@Module({
  imports: [
    MerchantsModule,
    AuditModule,
    EventIngestionModule,
    TransactionsModule,
    InvestigatorModule,
    VerifierModule,
  ],
  providers: [
    MonitoringService,
    { provide: APP_INTERCEPTOR, useClass: AuditFailureInterceptor },
  ],
  controllers: [MonitoringController],
})
export class MonitoringModule {}
