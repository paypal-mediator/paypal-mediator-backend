import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ENVIRONMENT, type Environment } from './config/environment.js';
import { PrismaService } from './database/prisma.service.js';

@Global()
@Module({})
export class CoreModule {
  static register(environment: Environment): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: ENVIRONMENT, useValue: environment },
        PrismaService,
      ],
      exports: [ENVIRONMENT, PrismaService],
    };
  }
}
