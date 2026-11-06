import { Module } from '@nestjs/common';
import { EvidenceService } from './evidence.service.js';

@Module({ providers: [EvidenceService], exports: [EvidenceService] })
export class EvidenceModule {}
