import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { DisputesModule } from '../disputes/index.js';
import { TransactionsModule } from '../transactions/index.js';
import { InvestigatorModule } from '../investigator/index.js';
import { SubmissionsModule } from '../submissions/index.js';
import { VerifierModule } from '../verifier/index.js';
import { MediationService } from './mediation.service.js';
import { MediationAgents } from './mediation-agents.js';
import { MediationController } from './mediation.controller.js';
import { MediationWorker } from './mediation.worker.js';
import { AuditModule } from '../monitoring/audit.module.js';
import { EvidenceModule } from '../evidence/index.js';
@Module({
  imports: [
    AuditModule,
    EvidenceModule,
    MerchantsModule,
    DisputesModule,
    TransactionsModule,
    InvestigatorModule,
    VerifierModule,
    SubmissionsModule,
  ],
  controllers: [MediationController],
  providers: [MediationService, MediationAgents, MediationWorker],
  exports: [MediationService],
})
export class MediationModule {}
