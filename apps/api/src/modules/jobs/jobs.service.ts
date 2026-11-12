import { Inject, Injectable, Logger } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Environment } from '../../common/config/environment.js';
import { ENVIRONMENT } from '../../common/config/environment.js';
import { AuditService } from '../monitoring/audit.service.js';

export type JobHandler = (data: unknown) => Promise<void>;
export interface JobOptions {
  /** Number of retries after the initial attempt. */
  retries?: number;
  /** Delay in milliseconds before the job becomes available. */
  delay?: number;
  /** Processing timeout in milliseconds, rounded up to whole seconds. */
  ttl?: number;
  priority?: number;
}
const JobContextSchema = z.object({ merchantId: z.uuid() });

/** Optional durable queue. Prisma ingestion workers remain independent. */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private boss?: PgBoss;
  private connecting?: Promise<void>;
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.boss) return;
    this.connecting = this.start();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async start() {
    const boss = new PgBoss(this.environment.DATABASE_URL);
    boss.on('error', () => this.logger.error('PG_BOSS_ERROR'));
    try {
      await boss.start();
      for (const [name, handler] of this.handlers) {
        await this.subscribe(boss, name, handler);
      }
      this.boss = boss;
      this.logger.log('pg-boss connected');
    } catch {
      await boss.stop().catch(() => this.logger.warn('PG_BOSS_STOP_FAILED'));
      this.logger.warn('PG_BOSS_CONNECTION_FAILED');
    }
  }

  async disconnect() {
    await this.connecting;
    const boss = this.boss;
    this.boss = undefined;
    await boss?.stop();
  }

  async registerHandler(name: string, handler: JobHandler) {
    if (this.handlers.has(name))
      throw new Error('JOB_HANDLER_ALREADY_REGISTERED');
    this.handlers.set(name, handler);
    if (this.connecting) {
      await this.connecting;
    } else if (this.boss) {
      try {
        await this.subscribe(this.boss, name, handler);
      } catch (error) {
        this.handlers.delete(name);
        throw error;
      }
    }
  }

  private async subscribe(boss: PgBoss, name: string, handler: JobHandler) {
    await boss.createQueue(name);
    await boss.work(name, async (jobs) => {
      for (const job of jobs) {
        const { merchantId } = JobContextSchema.parse(job.data);
        try {
          await handler(job.data);
        } catch (error) {
          try {
            await this.audit.append({
              merchantId,
              actorUserId: null,
              actorKind: 'SYSTEM',
              resourceType: 'INGESTION_JOB',
              resourceId: job.id,
              outcome: 'FAILED',
              record: {
                action: 'INGESTION_FINISHED',
                details: { state: 'FAILED', errorCode: 'JOB_ERROR' },
              },
            });
          } catch {
            this.logger.error('JOB_FAILURE_AUDIT_FAILED');
          }
          throw error;
        }
        await this.audit.append({
          merchantId,
          actorUserId: null,
          actorKind: 'SYSTEM',
          resourceType: 'INGESTION_JOB',
          resourceId: job.id,
          outcome: 'SUCCEEDED',
          record: {
            action: 'INGESTION_FINISHED',
            details: { state: 'COMPLETED' },
          },
        });
      }
    });
  }

  async enqueue(
    name: string,
    data: object,
    options: JobOptions = {},
  ): Promise<string> {
    if (!this.boss) throw new Error('PG_BOSS_NOT_CONNECTED');
    JobContextSchema.parse(data);
    const jobId = await this.boss.send(name, data, {
      retryLimit: options.retries ?? 3,
      startAfter: (options.delay ?? 0) / 1000,
      ...(options.ttl === undefined
        ? {}
        : { expireInSeconds: Math.ceil(options.ttl / 1000) }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    });
    if (!jobId) throw new Error('JOB_NOT_ENQUEUED');
    return jobId;
  }

  isConnected(): boolean {
    return Boolean(this.boss);
  }
}
