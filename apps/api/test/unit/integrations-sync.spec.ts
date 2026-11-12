import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationsService } from '../../src/modules/integrations/integrations.service.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { AuditService } from '../../src/modules/monitoring/audit.service.js';
import { JobsService } from '../../src/modules/jobs/jobs.service.js';
import { parseEnvironment } from '../../src/common/config/environment.js';

function setup() {
  const merchantId = randomUUID(),
    connectionId = randomUUID();
  const prisma = {
    erpConnection: {
      findFirst: vi.fn().mockResolvedValue({
        id: connectionId,
        merchantId,
        provider: 'mock-erp',
        status: 'connected',
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const jobs = {
    isConnected: vi.fn().mockReturnValue(true),
    enqueue: vi.fn().mockResolvedValue(randomUUID()),
    registerHandler: vi.fn(),
    connect: vi.fn(),
  };
  const service = new IntegrationsService(
    parseEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://mock:mock@localhost:1/mock',
    }),
    prisma as unknown as PrismaService,
    {} as AuditService,
    jobs as unknown as JobsService,
  );
  return { service, prisma, jobs, merchantId, connectionId };
}

describe('ERP sync queue boundary (MOCK database/queue)', () => {
  it('registers its worker before connecting', async () => {
    const { service, jobs } = setup();
    await service.onModuleInit();
    expect(jobs.registerHandler.mock.invocationCallOrder[0]).toBeLessThan(
      jobs.connect.mock.invocationCallOrder[0]!,
    );
  });

  it('returns 503 without pretending synchronization started when the queue is offline', async () => {
    const { service, jobs, prisma, merchantId, connectionId } = setup();
    jobs.isConnected.mockReturnValue(false);
    await expect(service.sync(merchantId, connectionId)).rejects.toMatchObject({
      code: 'ERP_QUEUE_UNAVAILABLE',
      status: 503,
    });
    expect(prisma.erpConnection.update).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('reports enqueue failure and stores an explicit error, including partial enqueue', async () => {
    const { service, jobs, prisma, merchantId, connectionId } = setup();
    jobs.enqueue
      .mockResolvedValueOnce(randomUUID())
      .mockRejectedValueOnce(new Error('MOCK offline'));
    await expect(service.sync(merchantId, connectionId)).rejects.toMatchObject({
      code: 'ERP_ENQUEUE_FAILED',
      status: 503,
    });
    expect(prisma.erpConnection.update).toHaveBeenLastCalledWith({
      where: { id: connectionId },
      data: { status: 'error', lastSyncError: 'ERP_ENQUEUE_FAILED' },
    });
  });

  it('marks syncing before workers can complete and queues only implemented resources', async () => {
    const { service, jobs, prisma, merchantId, connectionId } = setup();
    const result = await service.sync(merchantId, connectionId);
    expect(result).toEqual({
      ok: true,
      connectionId,
      resources: ['sales_orders', 'invoices', 'shipments'],
    });
    expect(
      prisma.erpConnection.update.mock.invocationCallOrder[0],
    ).toBeLessThan(jobs.enqueue.mock.invocationCallOrder[0]!);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'ERP_SYNC',
      expect.objectContaining({
        merchantId,
        connectionId,
        resource: 'sales_orders',
      }),
      { retries: 3, delay: 0 },
    );
  });

  it('allows an error connection to retry and rejects concurrent syncing with an actionable conflict', async () => {
    const { service, prisma, jobs, merchantId, connectionId } = setup();
    prisma.erpConnection.findFirst.mockResolvedValue({
      id: connectionId,
      merchantId,
      provider: 'mock-erp',
      status: 'error',
    });
    expect((await service.sync(merchantId, connectionId)).ok).toBe(true);
    jobs.enqueue.mockClear();
    prisma.erpConnection.findFirst.mockResolvedValue({
      id: connectionId,
      merchantId,
      provider: 'mock-erp',
      status: 'syncing',
    });
    await expect(service.sync(merchantId, connectionId)).rejects.toMatchObject({
      code: 'ERP_CONNECTION_NOT_READY',
      status: 409,
    });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
  it.each(['customers', 'documents', 'payments', 'invalid'])(
    'rejects unsupported resource %s instead of reporting empty success',
    async (resource) => {
      const { service, jobs, merchantId, connectionId } = setup();
      await expect(
        service.sync(merchantId, connectionId, resource),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_RESOURCE', status: 400 });
      expect(jobs.enqueue).not.toHaveBeenCalled();
    },
  );
});
