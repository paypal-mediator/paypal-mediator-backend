import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { TransactionsService } from '../transactions/index.js';
import { DisputesService } from '../disputes/index.js';
import { ShipmentTrackingService } from './shipment-tracking.service.js';

@Injectable()
export class ShipmentTrackingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShipmentTrackingWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running?: Promise<void>;
  private cursor?: string;
  private scanAt = 0;
  constructor(
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(DisputesService) private readonly disputes: DisputesService,
    @Inject(ShipmentTrackingService)
    private readonly tracking: ShipmentTrackingService,
  ) {}
  onModuleInit() {
    if (this.env.SHIPMENT_TRACKING_WORKER_ENABLED) this.schedule(0);
  }
  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, ms);
    this.timer.unref();
  }
  async processNext() {
    if (Date.now() >= this.scanAt) {
      const candidates = await this.transactions.trackingCandidates(
        undefined,
        this.cursor,
      );
      for (const row of candidates) {
        const links = await this.disputes.trackingLinks(row.merchantId, row.id);
        await this.tracking.schedule(
          row.merchantId,
          row.id,
          links[0]?.lastEventAt,
        );
      }
      this.cursor =
        candidates.length === 100 ? candidates.at(-1)?.id : undefined;
      this.scanAt = Date.now() + (this.cursor ? 1000 : 60000);
    }
    const now = new Date();
    const job = await this.prisma.shipmentTrackingJob.findFirst({
      where: {
        OR: [
          { nextAttemptAt: { lte: now }, leaseToken: null },
          { status: 'SYNCING', leaseExpiresAt: { lte: now } },
        ],
      },
      orderBy: { nextAttemptAt: 'asc' },
    });
    if (!job) return 'EMPTY';
    // Recover expired leases through the same central resolver.
    if (job.status === 'SYNCING' && job.nextAttemptAt === null)
      await this.prisma.shipmentTrackingJob.updateMany({
        where: {
          transactionId: job.transactionId,
          leaseToken: job.leaseToken,
          leaseExpiresAt: { lte: now },
        },
        data: { nextAttemptAt: now },
      });
    await this.tracking.resolveShipmentTracking(
      job.merchantId,
      job.transactionId,
    );
    return 'PROCESSED';
  }
  private async tick() {
    let delay = 1000;
    try {
      await this.processNext();
    } catch {
      this.logger.error('SHIPMENT_TRACKING_WORKER_UNAVAILABLE');
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
