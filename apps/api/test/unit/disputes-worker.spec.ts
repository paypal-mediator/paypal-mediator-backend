import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { parseEnvironment } from '../../src/common/config/environment.js';
import { DisputesService } from '../../src/modules/disputes/index.js';
import { DisputesWorker } from '../../src/modules/disputes/disputes.worker.js';

describe('M07 dispute worker scheduling', () => {
  const merchantId = '00000000-0000-4000-8000-000000000002';
  const processNextDispute = vi.fn<DisputesService['processNextDispute']>();
  let worker: DisputesWorker;

  function build(enabled: string, merchant?: string) {
    return new DisputesWorker(
      { processNextDispute } as unknown as DisputesService,
      parseEnvironment({
        DATABASE_URL: 'postgresql://localhost:1/MOCK',
        DISPUTE_WORKER_ENABLED: enabled,
        MERCHANT_ID: merchant,
      }),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    processNextDispute.mockReset();
    processNextDispute.mockResolvedValue('EMPTY');
  });
  afterEach(async () => {
    await worker?.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('inherits the capture worker opt-in when not set explicitly', () => {
    const environment = parseEnvironment({
      DATABASE_URL: 'postgresql://localhost:1/MOCK',
      TRANSACTION_WORKER_ENABLED: 'true',
    });
    expect(environment.DISPUTE_WORKER_ENABLED).toBe(true);
    expect(
      parseEnvironment({
        DATABASE_URL: 'postgresql://localhost:1/MOCK',
        TRANSACTION_WORKER_ENABLED: 'true',
        DISPUTE_WORKER_ENABLED: 'false',
      }).DISPUTE_WORKER_ENABLED,
    ).toBe(false);
  });

  it.each([
    ['false', merchantId],
    ['true', undefined],
  ])(
    'does not consume without opt-in and merchant (%s, %s)',
    async (enabled, merchant) => {
      worker = build(enabled, merchant);
      worker.onModuleInit();
      await vi.advanceTimersByTimeAsync(5000);
      expect(processNextDispute).not.toHaveBeenCalled();
    },
  );

  it('scopes consumption to the configured merchant and waits when empty', async () => {
    worker = build('true', merchantId);
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(processNextDispute).toHaveBeenCalledWith(merchantId);
    await vi.advanceTimersByTimeAsync(999);
    expect(processNextDispute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processNextDispute).toHaveBeenCalledTimes(2);
  });

  it('sanitizes unexpected failures and delays retries', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    processNextDispute.mockRejectedValueOnce(
      new Error('MOCK_SECRET_DATABASE_URL'),
    );
    worker = build('true', merchantId);
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith('DISPUTE_WORKER_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(4999);
    expect(processNextDispute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processNextDispute).toHaveBeenCalledTimes(2);
  });

  it('avoids overlapping consumers and waits for the active operation on shutdown', async () => {
    let finish!: (value: 'EMPTY') => void;
    processNextDispute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    worker = build('true', merchantId);
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(5000);
    expect(processNextDispute).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = worker.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish('EMPTY');
    await closing;
    await vi.advanceTimersByTimeAsync(5000);
    expect(processNextDispute).toHaveBeenCalledTimes(1);
  });
});
