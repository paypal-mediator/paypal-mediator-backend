import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { EvidenceService } from './evidence.service.js';
import { EvidenceStorage } from './evidence-storage.js';
import { PdfTextExtractor } from './pdf-text-extractor.js';

@Module({
  imports: [AuditModule],
  providers: [EvidenceService, EvidenceStorage, PdfTextExtractor],
  exports: [EvidenceService, PdfTextExtractor],
})
export class EvidenceModule {}
