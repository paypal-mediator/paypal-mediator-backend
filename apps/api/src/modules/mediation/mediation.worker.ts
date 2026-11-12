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
import { MediationService } from './mediation.service.js';
@Injectable()
export class MediationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediationWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private expirationTimer?: ReturnType<typeof setTimeout>;
  private expiring?: Promise<void>;
  private stopped = false;
  constructor(
    @Inject(MediationService) private readonly mediation: MediationService,
    @Inject(ENVIRONMENT) private readonly env: Environment,
  ) {}
  onModuleInit() {
    if (this.env.MEDIATION_WORKER_ENABLED && this.env.MERCHANT_ID) {
      this.schedule(0);
      this.scheduleExpiration();
    }
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, delay);
    this.timer.unref();
  }
  private async tick() {
    try {
      await this.mediation.tick(this.env.MERCHANT_ID!);
    } catch {
      this.logger.warn('MEDIATION_WORKER_UNAVAILABLE');
    } finally {
      this.schedule(30000);
    }
  }
  private scheduleExpiration() {
    if (this.stopped) return;
    this.expirationTimer = setTimeout(() => {
      this.expiring = this.expire();
    }, 1000);
    this.expirationTimer.unref();
  }
  private async expire() {
    try {
      await this.mediation.expireDue(this.env.MERCHANT_ID!);
    } catch {
      this.logger.warn('MEDIATION_EXPIRATION_UNAVAILABLE');
    } finally {
      this.scheduleExpiration();
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.expirationTimer);
    await Promise.all([this.running, this.expiring]);
  }
}
