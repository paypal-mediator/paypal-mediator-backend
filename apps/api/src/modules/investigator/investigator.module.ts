import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { MerchantsModule } from '../merchants/index.js';
import { TransactionsModule } from '../transactions/index.js';
import { AgentProvider, INVESTIGATOR_FETCH } from './agent-provider.js';
import { InvestigatorEngine } from './investigator.engine.js';
import { InvestigatorService } from './investigator.service.js';
import { InvestigatorController } from './investigator.controller.js';

@Module({
  imports: [MerchantsModule, TransactionsModule, AuditModule],
  controllers: [InvestigatorController],
  providers: [
    AgentProvider,
    InvestigatorEngine,
    InvestigatorService,
    { provide: INVESTIGATOR_FETCH, useFactory: () => globalThis.fetch },
  ],
  exports: [InvestigatorService, AgentProvider],
})
export class InvestigatorModule {}
