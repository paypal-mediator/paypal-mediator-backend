import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/index.js';
import { TransactionsModule } from '../transactions/index.js';
import { InvestigatorModule } from '../investigator/index.js';
import { ConciliationsService } from './conciliations.service.js';
import { ContactClassifier } from './contact-classifier.js';
import {
  BuyerContactController,
  ConciliationsController,
} from './conciliations.controller.js';

@Module({
  imports: [MerchantsModule, TransactionsModule, InvestigatorModule],
  controllers: [ConciliationsController, BuyerContactController],
  providers: [ConciliationsService, ContactClassifier],
  exports: [ConciliationsService],
})
export class ConciliationsModule {}
