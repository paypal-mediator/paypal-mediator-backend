import { Module, type DynamicModule } from '@nestjs/common';
import type { Environment } from './common/config/environment.js';
import { CoreModule } from './common/core.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({})
export class AppModule {
  static register(environment: Environment): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.register(environment), HealthModule],
    };
  }
}
