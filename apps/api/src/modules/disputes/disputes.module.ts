import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { EventIngestionModule } from '../event-ingestion/index.js';
import { DisputesController } from './disputes.controller.js';
import { DisputesService } from './disputes.service.js';
import { DisputesWorker } from './disputes.worker.js';

@Module({
  imports: [MerchantsModule, EventIngestionModule],
  controllers: [DisputesController],
  providers: [DisputesService, DisputesWorker],
  exports: [DisputesService],
})
export class DisputesModule {}
