import { createRequire } from 'node:module';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Environment } from '../../common/config/environment.js';
import { ENVIRONMENT } from '../../common/config/environment.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { AuditService } from '../monitoring/audit.service.js';

const require = createRequire(import.meta.url);
// pg-boss es CommonJS; importarlo mediante require para ESM.
const Boss: new (connectionString: string) => {
  start: () => Promise<void>;
  close: () => Promise<void>;
  subscribe: <T = unknown>(
    name: string,
    handler: (job: { id: string; data: T }) => Promise<void>,
  ) => Promise<void>;
  send: (
    name: string,
    data: unknown,
    options?: {
      retries?: number;
      delay?: number;
      ttl?: number;
      priority?: number;
    },
  ) => Promise<string>;
} = require('pg-boss');

export type JobHandler = (data: unknown) => Promise<void>;

export interface JobOptions {
  /** Retry count before the job is moved to the dead letter queue. */
  retries?: number;
  /** Delay in milliseconds before the job becomes available. */
  delay?: number;
  /** TTL in milliseconds after which the job expires. */
  ttl?: number;
  /** Priority (higher = processed first). */
  priority?: number;
}

/**
 * pg-boss adapter backed by the same PostgreSQL instance as the application.
 *
 * Jobs are durably stored in PostgreSQL (`pgboss_*` tables) and processed by
 * worker(s) running inside this Node process. This replaces the ad-hoc
 * ingestion queue for workloads that need retries, delays or dead-letter
 * handling without adding Redis or another external broker.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private boss?: Boss;
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Connects to PostgreSQL and starts listening for all registered handlers.
   * Safe to call multiple times (idempotent).
   */
  async connect() {
    if (this.boss) return;
    const connectionString = this.environment.DATABASE_URL;
    this.logger.log('Connecting pg-boss to PostgreSQL');
    try {
      this.boss = new Boss(connectionString);
      await this.boss.start();

      // Subscribe to all handlers registered before connect.
      for (const [name, handler] of this.handlers) {
        void this.subscribe(name, handler);
      }
      this.logger.log('pg-boss connected');
    } catch (error) {
      // pg-boss is optional: the ingestion outbox in Prisma works without it.
      this.logger.warn(`pg-boss connection failed: ${String(error)}`);
    }
  }

  async disconnect() {
    if (!this.boss) return;
    await this.boss.close();
    this.boss = undefined;
    this.logger.log('pg-boss disconnected');
  }

  /**
   * Registers a handler for a named job type. If pg-boss is already connected,
   * subscribes immediately.
   */
  registerHandler(name: string, handler: JobHandler) {
    this.handlers.set(name, handler);
    if (this.boss) {
      void this.subscribe(name, handler);
    }
  }

  private subscribe(name: string, handler: JobHandler) {
    return this.boss!.subscribe(name, async (job: unknown) => {
      try {
        await handler((job as { data: unknown }).data);
        await this.audit.append({
          merchantId: null as unknown as string,
          actorUserId: null,
          actorKind: 'SYSTEM',
          resourceType: 'INGESTION_JOB',
          resourceId: (job as { id: string }).id,
          outcome: 'SUCCEEDED',
          record: {
            action: 'INGESTION_FINISHED',
            details: { state: 'COMPLETED' },
          },
        });
      } catch (error) {
        await this.audit.append({
          merchantId: null as unknown as string,
          actorUserId: null,
          actorKind: 'SYSTEM',
          resourceType: 'INGESTION_JOB',
          resourceId: (job as { id: string }).id,
          outcome: 'FAILED',
          record: {
            action: 'INGESTION_FINISHED',
            details: { state: 'FAILED', errorCode: 'JOB_ERROR' as const },
          },
        });
        throw error;
      }
    });
  }

  /**
   * Enqueues a new job. Returns the pg-boss job id.
   */
  async enqueue(
    name: string,
    data: unknown,
    options: JobOptions = {},
  ): Promise<string> {
    if (!this.boss) {
      throw new Error('pg-boss is not connected');
    }
    const jobId = await this.boss.send(name, data, {
      retries: options.retries ?? 3,
      delay: options.delay ?? 0,
      ttl: options.ttl,
      priority: options.priority,
    });
    this.logger.debug(`Enqueued job ${name} id=${jobId}`);
    return jobId;
  }

  /**
   * Returns true if pg-boss is connected.
   */
  isConnected(): boolean {
    return Boolean(this.boss);
  }
}
