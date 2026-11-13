import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DisputeWorkflowController } from '../../src/modules/verifier/dispute-workflow.controller.js';
import type { MerchantRequest } from '../../src/modules/merchants/index.js';

function setup() {
  const id = randomUUID(),
    transactionId = randomUUID(),
    investigationId = randomUUID();
  const dispute = {
    id,
    paypalDisputeId: 'PP-D-MOCK',
    paypalStatus: 'OPEN',
    reasonCategory: 'ITEM_NOT_RECEIVED',
    lastEventAt: new Date().toISOString(),
    link: { status: 'LINKED', transactionId },
  };
  const disputes = {
    detail: vi.fn().mockImplementation(async () => structuredClone(dispute)),
    conversationForTransaction: vi
      .fn()
      .mockResolvedValue({ paypalDisputeId: dispute.paypalDisputeId }),
  };
  const investigator = {
    start: vi.fn().mockResolvedValue({
      id: investigationId,
      status: 'COMPLETED',
      stale: false,
    }),
  };
  const verifier = {
    verify: vi.fn().mockResolvedValue({
      id: randomUUID(),
      status: 'COMPLETED',
      scope: 'DISPUTE_INR',
    }),
  };
  type Args = ConstructorParameters<typeof DisputeWorkflowController>;
  const controller = new DisputeWorkflowController(
    disputes as unknown as Args[0],
    investigator as unknown as Args[1],
    verifier as unknown as Args[2],
  );
  const request = {
    merchantActor: {
      merchantId: randomUUID(),
      userId: randomUUID(),
      role: 'ADMIN',
    },
  } as MerchantRequest;
  const body = { idempotencyKey: randomUUID() };
  return {
    id,
    transactionId,
    investigationId,
    disputes,
    dispute,
    investigator,
    verifier,
    request,
    body,
    run: () => controller.investigate(request, id, body),
  };
}
describe('M07 investigation → independent M06 composition (MOCK services)', () => {
  it('passes the authorized case and completed run to M06 without authorizing submission', async () => {
    const test = setup();
    expect(await test.run()).toMatchObject({
      verification: { scope: 'DISPUTE_INR' },
      submissionAuthorized: false,
    });
    expect(test.verifier.verify).toHaveBeenCalledWith(
      test.request.merchantActor,
      test.transactionId,
      test.investigationId,
      { idempotencyKey: test.body.idempotencyKey, disputeId: test.id },
    );
  });
  it('stops after a failed investigation', async () => {
    const test = setup();
    test.investigator.start.mockResolvedValue({
      status: 'FAILED',
      stale: false,
    });
    expect(await test.run()).toMatchObject({
      verification: null,
      submissionAuthorized: false,
    });
    expect(test.verifier.verify).not.toHaveBeenCalled();
  });
  it('stops when the dispute changes during investigation', async () => {
    const test = setup();
    test.disputes.detail
      .mockResolvedValueOnce(structuredClone(test.dispute))
      .mockResolvedValueOnce({
        ...test.dispute,
        lastEventAt: '2000-01-01T00:00:00.000Z',
      });
    await expect(test.run()).rejects.toMatchObject({
      code: 'DISPUTE_CONTEXT_CHANGED',
    });
    expect(test.verifier.verify).not.toHaveBeenCalled();
  });
  it('rejects an investigator context belonging to another dispute', async () => {
    const test = setup();
    test.disputes.conversationForTransaction.mockResolvedValue({
      paypalDisputeId: 'PP-D-OTHER',
    });
    await expect(test.run()).rejects.toMatchObject({
      code: 'DISPUTE_CONTEXT_CONFLICT',
    });
    expect(test.investigator.start).not.toHaveBeenCalled();
  });
  it.each(['RESOLVED', 'UNLINKED', 'NOT_AS_DESCRIBED'])(
    'rejects ineligible case %s',
    async (value) => {
      const test = setup();
      if (value === 'RESOLVED') test.dispute.paypalStatus = value;
      else if (value === 'UNLINKED') test.dispute.link.status = value;
      else test.dispute.reasonCategory = value;
      await expect(test.run()).rejects.toMatchObject({
        code: 'DISPUTE_NOT_VERIFIABLE',
      });
      expect(test.investigator.start).not.toHaveBeenCalled();
    },
  );
});
