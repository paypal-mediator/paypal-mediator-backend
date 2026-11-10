import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { JobsService } from './jobs.service.js';

@Module({
  imports: [AuditModule],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
