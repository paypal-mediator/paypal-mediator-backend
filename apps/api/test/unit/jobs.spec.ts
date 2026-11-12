import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditWriteSchema } from '@resolve-ai/contracts';
import { PgBoss } from 'pg-boss';
import { JobsService } from '../../src/modules/jobs/jobs.service.js';
import { AuditService } from '../../src/modules/monitoring/audit.service.js';
import { parseEnvironment } from '../../src/common/config/environment.js';

vi.mock('pg-boss', () => ({ PgBoss: vi.fn() }));

describe('durable jobs (MOCK pg-boss)', () => {
  const merchantId = randomUUID();
  let worker: (jobs: Array<{ id: string; data: unknown }>) => Promise<void>;
  const boss = {
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    createQueue: vi.fn(),
    work: vi.fn(),
    send: vi.fn(),
  };
  const append = vi.fn();
  let jobs: JobsService;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(PgBoss).mockImplementation(function () {
      return boss as unknown as PgBoss;
    });
    boss.start.mockResolvedValue(undefined);
    boss.stop.mockResolvedValue(undefined);
    boss.createQueue.mockResolvedValue(undefined);
    boss.work.mockImplementation(async (_name, handler) => {
      worker = handler;
      return 'worker';
    });
    boss.send.mockResolvedValue(randomUUID());
    append.mockImplementation(async (value) => AuditWriteSchema.parse(value));
    jobs = new JobsService(
      parseEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://mock:mock@localhost:1/mock',
      }),
      {
        append,
      } as unknown as AuditService,
    );
  });

  it('waits for startup and queue creation before reporting connected', async () => {
    let resolveStart!: () => void;
    boss.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    await jobs.registerHandler('ERP_SYNC', vi.fn());
    const first = jobs.connect(),
      second = jobs.connect();
    expect(jobs.isConnected()).toBe(false);
    await expect(jobs.enqueue('ERP_SYNC', { merchantId })).rejects.toThrow(
      'PG_BOSS_NOT_CONNECTED',
    );
    resolveStart();
    await Promise.all([first, second]);
    expect(PgBoss).toHaveBeenCalledTimes(1);
    expect(boss.createQueue).toHaveBeenCalledWith('ERP_SYNC');
    expect(boss.createQueue.mock.invocationCallOrder[0]).toBeLessThan(
      boss.work.mock.invocationCallOrder[0]!,
    );
    expect(jobs.isConnected()).toBe(true);
    await jobs.connect();
    expect(boss.work).toHaveBeenCalledTimes(1);
  });

  it.each(['start', 'createQueue', 'work'] as const)(
    'cleans up after %s failure and permits retry',
    async (method) => {
      boss[method].mockRejectedValueOnce(new Error('MOCK failure'));
      await jobs.registerHandler('ERP_SYNC', vi.fn());
      await jobs.connect();
      expect(jobs.isConnected()).toBe(false);
      expect(boss.stop).toHaveBeenCalledTimes(1);
      await jobs.connect();
      expect(jobs.isConnected()).toBe(true);
    },
  );

  it('audits successful work under its actual merchant', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await jobs.registerHandler('ERP_SYNC', handler);
    await jobs.connect();
    const id = randomUUID();
    await worker([{ id, data: { merchantId, explicitMock: true } }]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId,
        resourceId: id,
        outcome: 'SUCCEEDED',
      }),
    );
  });

  it('preserves the handler error even when failure auditing also fails', async () => {
    const failure = new Error('MOCK handler error');
    await jobs.registerHandler('ERP_SYNC', vi.fn().mockRejectedValue(failure));
    await jobs.connect();
    append.mockRejectedValueOnce(new Error('MOCK audit unavailable'));
    await expect(
      worker([{ id: randomUUID(), data: { merchantId } }]),
    ).rejects.toBe(failure);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId, outcome: 'FAILED' }),
    );
  });

  it('rejects invalid merchant context before executing a job', async () => {
    const handler = vi.fn();
    await jobs.registerHandler('ERP_SYNC', handler);
    await jobs.connect();
    await expect(
      worker([{ id: randomUUID(), data: { merchantId: null } }]),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('translates retries, delay and timeout to installed pg-boss options', async () => {
    await jobs.connect();
    await jobs.enqueue(
      'ERP_SYNC',
      { merchantId },
      { retries: 4, delay: 1500, ttl: 1501, priority: 2 },
    );
    expect(boss.send).toHaveBeenCalledWith(
      'ERP_SYNC',
      { merchantId },
      { retryLimit: 4, startAfter: 1.5, expireInSeconds: 2, priority: 2 },
    );
    boss.send.mockResolvedValueOnce(null);
    await expect(jobs.enqueue('ERP_SYNC', { merchantId })).rejects.toThrow(
      'JOB_NOT_ENQUEUED',
    );
  });

  it('awaits registration after connection and surfaces subscription failures', async () => {
    await jobs.connect();
    boss.work.mockRejectedValueOnce(new Error('MOCK registration failure'));
    await expect(jobs.registerHandler('ERP_SYNC', vi.fn())).rejects.toThrow(
      'MOCK registration failure',
    );
    await jobs.registerHandler('ERP_SYNC', vi.fn());
    await expect(jobs.registerHandler('ERP_SYNC', vi.fn())).rejects.toThrow(
      'JOB_HANDLER_ALREADY_REGISTERED',
    );
    await jobs.disconnect();
    expect(jobs.isConnected()).toBe(false);
  });
});
