import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { EvidenceService } from './evidence.service.js';
import { EvidenceStorage } from './evidence-storage.js';

@Module({
  imports: [AuditModule],
  providers: [EvidenceService, EvidenceStorage],
  exports: [EvidenceService],
})
export class EvidenceModule {}
