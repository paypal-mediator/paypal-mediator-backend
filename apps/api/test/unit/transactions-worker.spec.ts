import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { parseEnvironment } from '../../src/common/config/environment.js';
import { TransactionsService } from '../../src/modules/transactions/index.js';
import { TransactionsWorker } from '../../src/modules/transactions/transactions.worker.js';

describe('M03 worker scheduling', () => {
  const merchantId = '00000000-0000-4000-8000-000000000001';
  const processNextCapture = vi.fn<TransactionsService['processNextCapture']>();
  const processNextOrderSource = vi.fn().mockResolvedValue('EMPTY');
  let worker: TransactionsWorker;
  function start(enabled: boolean, merchant: string | undefined = merchantId) {
    worker = new TransactionsWorker(
      {
        processNextCapture,
        processNextOrderSource,
      } as unknown as TransactionsService,
      parseEnvironment({
        DATABASE_URL: 'postgresql://localhost:1/MOCK',
        TRANSACTION_WORKER_ENABLED: String(enabled),
        MERCHANT_ID: merchant,
      }),
    );
    worker.onModuleInit();
  }
  beforeEach(() => {
    vi.useFakeTimers();
    processNextCapture.mockReset();
    processNextCapture.mockResolvedValue('EMPTY');
  });
  afterEach(async () => {
    await worker?.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each([
    [false, merchantId],
    [true, undefined],
  ])(
    'does not consume without opt-in and merchant (%s, %s)',
    async (enabled, merchant) => {
      // Pass undefined explicitly in configuration, bypassing the helper default.
      worker = new TransactionsWorker(
        {
          processNextCapture,
          processNextOrderSource,
        } as unknown as TransactionsService,
        parseEnvironment({
          DATABASE_URL: 'postgresql://localhost:1/MOCK',
          TRANSACTION_WORKER_ENABLED: String(enabled),
          MERCHANT_ID: merchant,
        }),
      );
      worker.onModuleInit();
      await vi.advanceTimersByTimeAsync(5000);
      expect(processNextCapture).not.toHaveBeenCalled();
    },
  );
  it('scopes consumption to the configured merchant and waits when empty', async () => {
    start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(processNextCapture).toHaveBeenCalledWith(merchantId);
    await vi.advanceTimersByTimeAsync(999);
    expect(processNextCapture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processNextCapture).toHaveBeenCalledTimes(2);
  });
  it('delays retries and sanitizes unexpected failures', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    processNextCapture.mockRejectedValueOnce(
      new Error('MOCK_SECRET_DATABASE_URL'),
    );
    start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith('CAPTURE_WORKER_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(4999);
    expect(processNextCapture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processNextCapture).toHaveBeenCalledTimes(2);
  });
  it('avoids overlapping consumers and waits for the active operation on shutdown', async () => {
    let finish!: (value: 'EMPTY') => void;
    processNextCapture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    start(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(processNextCapture).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = worker.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish('EMPTY');
    await closing;
    await vi.advanceTimersByTimeAsync(5000);
    expect(processNextCapture).toHaveBeenCalledTimes(1);
  });
});
