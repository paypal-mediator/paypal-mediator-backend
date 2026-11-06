import { Module } from '@nestjs/common';
import { EvidenceService } from './evidence.service.js';
import { EvidenceStorage } from './evidence-storage.js';

@Module({
  providers: [EvidenceService, EvidenceStorage],
  exports: [EvidenceService],
})
export class EvidenceModule {}
