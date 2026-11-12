import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { TransactionsModule } from '../transactions/index.js';
import { DisputesModule } from '../disputes/index.js';
import { IntegrationsModule } from '../integrations/index.js';
import { EvidenceModule } from '../evidence/index.js';
import { ShipmentTrackingService } from './shipment-tracking.service.js';
import {
  ShipmentTrackingController,
  TrackingWebhookController,
} from './shipment-tracking.controller.js';
import {
  SeventeenTrackClient,
  TRACKING_FETCH,
} from './seventeentrack.client.js';
import { TrackingRegistrationService } from './tracking-registration.service.js';
import { PayPalTrackingSource } from './paypal-tracking.source.js';
import { ShipmentTrackingWorker } from './shipment-tracking.worker.js';
import { TrackingWebhookService } from './tracking-webhook.service.js';
@Module({
  imports: [
    MerchantsModule,
    TransactionsModule,
    DisputesModule,
    IntegrationsModule,
    EvidenceModule,
  ],
  controllers: [ShipmentTrackingController, TrackingWebhookController],
  providers: [
    ShipmentTrackingService,
    SeventeenTrackClient,
    TrackingRegistrationService,
    PayPalTrackingSource,
    ShipmentTrackingWorker,
    TrackingWebhookService,
    { provide: TRACKING_FETCH, useFactory: () => globalThis.fetch },
  ],
  exports: [ShipmentTrackingService],
})
export class ShipmentTrackingModule {}
