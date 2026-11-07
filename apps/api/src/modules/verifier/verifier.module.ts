import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { MerchantsModule } from '../merchants/index.js';
import { TransactionsModule } from '../transactions/index.js';
import { InvestigatorModule } from '../investigator/index.js';
import { VerifierEngine } from './verifier.engine.js';
import { VerifierService } from './verifier.service.js';
import { VerifierController } from './verifier.controller.js';
@Module({
  imports: [
    MerchantsModule,
    TransactionsModule,
    InvestigatorModule,
    AuditModule,
  ],
  controllers: [VerifierController],
  providers: [VerifierEngine, VerifierService],
  exports: [VerifierService],
})
export class VerifierModule {}
