import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { EventIngestionModule } from '../event-ingestion/index.js';
import { TransactionsController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';
import { TransactionsWorker } from './transactions.worker.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { EvidenceModule } from '../evidence/index.js';

@Module({
  imports: [MerchantsModule, EventIngestionModule, EvidenceModule],
  controllers: [TransactionsController, OrdersController],
  providers: [TransactionsService, TransactionsWorker, OrdersService],
  exports: [TransactionsService, OrdersService],
})
export class TransactionsModule {}
