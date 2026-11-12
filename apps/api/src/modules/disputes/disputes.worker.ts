import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { DisputesService } from './disputes.service.js';
import { MerchantsService } from '../merchants/index.js';

@Injectable()
export class DisputesWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DisputesWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running?: Promise<void>;

  constructor(
    @Inject(DisputesService) private readonly disputes: DisputesService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Optional()
    @Inject(MerchantsService)
    private readonly merchants?: MerchantsService,
  ) {}

  onModuleInit() {
    if (
      this.environment.DISPUTE_WORKER_ENABLED &&
      (this.environment.MERCHANT_ID || this.merchants)
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
      const ids = this.merchants
        ? await this.merchants.paypalWorkerMerchants()
        : [this.environment.MERCHANT_ID!];
      for (const merchantId of ids) {
        const result = await this.disputes.processNextDispute(merchantId);
        if (result !== 'EMPTY') delay = 0;
        if (result === 'FAILED') this.logger.warn('DISPUTE_JOB_REJECTED');
      }
    } catch {
      // No payloads, connection strings or raw database errors in logs.
      this.logger.error('DISPUTE_WORKER_UNAVAILABLE');
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
