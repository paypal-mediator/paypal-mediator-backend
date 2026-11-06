import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { ENVIRONMENT, type Environment } from '../config/environment.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENVIRONMENT) environment: Environment) {
    super({
      adapter: new PrismaPg({
        connectionString: environment.DATABASE_URL,
        connectionTimeoutMillis: environment.DB_CONNECTION_TIMEOUT_MS,
        idleTimeoutMillis: 10000,
        max: 5,
        statement_timeout: environment.DB_CONNECTION_TIMEOUT_MS,
        query_timeout: environment.DB_CONNECTION_TIMEOUT_MS,
      }),
      log: [],
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
