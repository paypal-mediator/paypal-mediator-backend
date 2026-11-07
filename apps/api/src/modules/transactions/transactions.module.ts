import { Module } from '@nestjs/common';
import { AuditModule } from '../monitoring/audit.module.js';
import { MerchantsModule } from '../merchants/index.js';
import { EventIngestionModule } from '../event-ingestion/index.js';
import { TransactionsController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';
import { TransactionsWorker } from './transactions.worker.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { EvidenceModule } from '../evidence/index.js';
import { PayPalOrderSource } from './sources/paypal-order-source.js';
import { OrderSourcesService } from './sources/order-sources.service.js';
import { ORDER_INFORMATION_SOURCES } from './sources/order-information-source.js';

@Module({
  imports: [MerchantsModule, EventIngestionModule, EvidenceModule, AuditModule],
  controllers: [TransactionsController, OrdersController],
  providers: [
    TransactionsService,
    TransactionsWorker,
    OrdersService,
    PayPalOrderSource,
    OrderSourcesService,
    {
      provide: ORDER_INFORMATION_SOURCES,
      inject: [PayPalOrderSource],
      useFactory: (paypal: PayPalOrderSource) => [paypal],
    },
  ],
  exports: [TransactionsService, OrdersService],
})
export class TransactionsModule {}
