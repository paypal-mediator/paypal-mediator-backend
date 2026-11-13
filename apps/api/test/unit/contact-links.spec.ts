import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConciliationsService } from '../../src/modules/conciliations/conciliations.service.js';
import type { PrismaService } from '../../src/common/database/prisma.service.js';
import type {
  OrdersService,
  TransactionsService,
} from '../../src/modules/transactions/index.js';
import type { ContactClassifier } from '../../src/modules/conciliations/contact-classifier.js';
import type { AgentProvider } from '../../src/modules/investigator/index.js';

describe('contact links through public commerce interfaces (MOCK database/commerce)', () => {
  it('can link a verified team payment without inventing a commercial order', async () => {
    const detail = vi.fn().mockResolvedValue({
      merchantOrderReference: null,
      paypalOrderId: null,
      paypalCaptureId: 'MOCK-CAPTURE',
      order: null,
    });
    const create = vi
      .fn()
      .mockImplementation(async ({ data }) => ({ ...data, id: 'MOCK-chat' }));
    const db = {
      conciliationChat: { count: vi.fn().mockResolvedValue(0), create },
    };
    const service = new ConciliationsService(
      db as unknown as PrismaService,
      {} as OrdersService,
      { detail } as unknown as TransactionsService,
      {} as ContactClassifier,
      {} as AgentProvider,
    );
    const result = await service.createLink(
      { merchantId: 'team-A', userId: 'user-A', role: 'ADMIN' },
      undefined,
      7,
      'MOCK-payment',
    );
    expect(detail).toHaveBeenCalledWith('team-A', 'MOCK-payment');
    expect(create.mock.calls[0]![0].data).toMatchObject({
      merchantId: 'team-A',
      transactionId: 'MOCK-payment',
      orderId: null,
      orderReference: 'MOCK-CAPTURE',
    });
    expect(create.mock.calls[0]![0].data.tokenHash).not.toBe(result.token);
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    detail.mockRejectedValue(new Error('MOCK transaction not accessible'));
    create.mockClear();
    await expect(
      service.createLink(
        { merchantId: 'team-B', userId: 'user-A', role: 'ADMIN' },
        undefined,
        7,
        'MOCK-payment',
      ),
    ).rejects.toThrow('not accessible');
    expect(create).not.toHaveBeenCalled();
  });
});
