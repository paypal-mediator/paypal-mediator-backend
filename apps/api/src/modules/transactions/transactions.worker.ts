import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { TransactionsService } from './transactions.service.js';

@Injectable()
export class TransactionsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TransactionsWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running?: Promise<void>;

  constructor(
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {}

  onModuleInit() {
    if (
      this.environment.TRANSACTION_WORKER_ENABLED &&
      this.environment.MERCHANT_ID
    )
      this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, delay);
    this.timer.unref();
  }

  private async tick() {
    let delay = 1000;
    try {
      const result = await this.transactions.processNextCapture(
        this.environment.MERCHANT_ID!,
      );
      if (result !== 'EMPTY') delay = 0;
      if (result === 'FAILED') this.logger.warn('CAPTURE_JOB_REJECTED');
      const enrichment = await this.transactions.processNextOrderSource(
        this.environment.MERCHANT_ID!,
      );
      if (enrichment !== 'EMPTY') delay = 0;
    } catch {
      // No payloads, connection strings or raw database errors in logs.
      this.logger.error('CAPTURE_WORKER_UNAVAILABLE');
      delay = 5000;
    } finally {
      this.schedule(delay);
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
