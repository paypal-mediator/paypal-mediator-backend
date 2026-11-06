import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { EventIngestionController } from './event-ingestion.controller.js';
import { EventIngestionService } from './event-ingestion.service.js';
import { PayPalWebhookVerifier } from './paypal-webhook.verifier.js';

@Module({
  imports: [MerchantsModule],
  controllers: [EventIngestionController],
  providers: [EventIngestionService, PayPalWebhookVerifier],
  exports: [EventIngestionService],
})
export class EventIngestionModule {}
