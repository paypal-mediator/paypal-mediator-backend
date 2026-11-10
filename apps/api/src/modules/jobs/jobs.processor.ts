import { Injectable, Logger } from '@nestjs/common';
import { JobsService } from './jobs.service.js';

@Injectable()
export class JobsProcessor {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(private readonly jobs: JobsService) {}

  /**
   * Registers all job handlers with the given JobsService.
   * Called by IntegrationsService.onModuleInit.
   */
  registerHandlers() {
    // ERP_SYNC handler is registered by IntegrationsService to avoid circular deps.
    this.logger.log('JobsProcessor ready');
  }
}
