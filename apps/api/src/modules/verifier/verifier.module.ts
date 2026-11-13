import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { MerchantsModule } from '../merchants/index.js';
import { TransactionsModule } from '../transactions/index.js';
import { InvestigatorModule } from '../investigator/index.js';
import { VerifierEngine } from './verifier.engine.js';
import { VerifierService } from './verifier.service.js';
import { VerifierController } from './verifier.controller.js';
import { DisputesModule } from '../disputes/index.js';
import { DisputeWorkflowController } from './dispute-workflow.controller.js';
@Module({
  imports: [
    MerchantsModule,
    TransactionsModule,
    InvestigatorModule,
    AuditModule,
    DisputesModule,
  ],
  controllers: [VerifierController, DisputeWorkflowController],
  providers: [VerifierEngine, VerifierService],
  exports: [VerifierService],
})
export class VerifierModule {}
