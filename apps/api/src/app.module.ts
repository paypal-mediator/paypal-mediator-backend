import { Module, type DynamicModule } from '@nestjs/common';
import type { Environment } from './common/config/environment.js';
import { CoreModule } from './common/core.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { MerchantsModule } from './modules/merchants/index.js';
import { EventIngestionModule } from './modules/event-ingestion/index.js';
import { TransactionsModule } from './modules/transactions/index.js';
import { VerifierModule } from './modules/verifier/index.js';
import { InvestigatorModule } from './modules/investigator/index.js';
import { MonitoringModule } from './modules/monitoring/monitoring.module.js';
import { DisputesModule } from './modules/disputes/index.js';
import { SubmissionsModule } from './modules/submissions/index.js';
import { BillingModule } from './modules/billing/index.js';
import { JobsModule } from './modules/jobs/index.js';
import { IntegrationsModule } from './modules/integrations/index.js';

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
        InvestigatorModule,
        VerifierModule,
        MonitoringModule,
        DisputesModule,
        SubmissionsModule,
        BillingModule,
        JobsModule,
        IntegrationsModule,
      ],
    };
  }
}
