import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { MerchantsModule } from '../merchants/index.js';
import { EventIngestionController } from './event-ingestion.controller.js';
import { EventIngestionService } from './event-ingestion.service.js';
import { PayPalWebhookVerifier } from './paypal-webhook.verifier.js';
import { IngestionQueueService } from './ingestion-queue.service.js';
import { IngestionOperationsController } from './ingestion-operations.controller.js';
import { IngestionOperationsService } from './ingestion-operations.service.js';

@Module({
  imports: [MerchantsModule, AuditModule],
  controllers: [EventIngestionController, IngestionOperationsController],
  providers: [
    EventIngestionService,
    PayPalWebhookVerifier,
    IngestionQueueService,
    IngestionOperationsService,
  ],
  exports: [EventIngestionService, IngestionQueueService],
})
export class EventIngestionModule {}
