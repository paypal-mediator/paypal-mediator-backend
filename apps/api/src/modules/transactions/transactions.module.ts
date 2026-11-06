import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { EventIngestionModule } from '../event-ingestion/index.js';
import { TransactionsController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';
import { TransactionsWorker } from './transactions.worker.js';

@Module({
  imports: [MerchantsModule, EventIngestionModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, TransactionsWorker],
  exports: [TransactionsService],
})
export class TransactionsModule {}
