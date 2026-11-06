import { Module, type DynamicModule } from '@nestjs/common';
import type { Environment } from './common/config/environment.js';
import { CoreModule } from './common/core.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { MerchantsModule } from './modules/merchants/index.js';
import { EventIngestionModule } from './modules/event-ingestion/index.js';
import { TransactionsModule } from './modules/transactions/index.js';

@Module({})
export class AppModule {
  static register(environment: Environment): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.register(environment),
        HealthModule,
        MerchantsModule,
        EventIngestionModule,
        TransactionsModule,
      ],
    };
  }
}
