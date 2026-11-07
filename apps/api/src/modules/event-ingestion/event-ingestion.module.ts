import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { MerchantsModule } from '../merchants/index.js';
import { EventIngestionController } from './event-ingestion.controller.js';
import { EventIngestionService } from './event-ingestion.service.js';
import { PayPalWebhookVerifier } from './paypal-webhook.verifier.js';
import { IngestionQueueService } from './ingestion-queue.service.js';

@Module({
  imports: [MerchantsModule, AuditModule],
  controllers: [EventIngestionController],
  providers: [
    EventIngestionService,
    PayPalWebhookVerifier,
    IngestionQueueService,
  ],
  exports: [EventIngestionService, IngestionQueueService],
})
export class EventIngestionModule {}
