import { describe, expect, it } from 'vitest';
import { IngestionRejection } from '../../src/modules/event-ingestion/index.js';
import { parseDisputeEvent } from '../../src/modules/disputes/index.js';
import { disputeEvent } from '../fixtures/dispute.js';

describe('M07 dispute webhook parser (DEMO / MOCK payloads)', () => {
  it('normalizes PayPal fields without deriving a local outcome', () => {
    const parsed = parseDisputeEvent(disputeEvent());
    expect(parsed).toMatchObject({
      eventType: 'CUSTOMER.DISPUTE.CREATED',
      paypalDisputeId: 'PP-D-MOCK',
      paypalStatus: 'OPEN',
      paypalStage: 'INQUIRY',
      paypalReason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      paypalOutcome: null,
      reasonCategory: 'ITEM_NOT_RECEIVED',
      amount: { currencyCode: 'USD', value: '10.25' },
      sellerTransactionIds: ['MOCK-CAPTURE'],
      resolution: null,
    });
    expect(parsed.occurredAt.toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(parsed.disputedAt.toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(parsed.deadlineAt?.toISOString()).toBe('2026-11-20T00:00:00.000Z');
  });

  it.each([
    ['RESOLVED_SELLER_FAVOUR', 'RESOLVED_WON'],
    ['RESOLVED_BUYER_FAVOUR', 'RESOLVED_LOST'],
    ['RESOLVED_WITH_PAYOUT', 'CLOSED'],
  ])('uses only the official outcome %s', (outcome, state) => {
    const parsed = parseDisputeEvent(
      disputeEvent({
        eventType: 'CUSTOMER.DISPUTE.RESOLVED',
        status: 'RESOLVED',
        outcome,
      }),
    );
    expect(parsed.resolution).toBe(state);
  });

  it('preserves unknown PayPal values as OTHER', () => {
    const parsed = parseDisputeEvent(
      disputeEvent({
        status: 'SOMETHING_NEW',
        stage: 'FUTURE_STAGE',
        reason: 'SOMETHING_ELSE',
      }),
    );
    expect(parsed).toMatchObject({
      paypalStatus: 'OTHER',
      paypalStage: 'OTHER',
      reasonCategory: 'OTHER',
      resolution: null,
    });
  });

  it('classifies the remaining supported reasons', () => {
    expect(
      parseDisputeEvent(
        disputeEvent({ reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' }),
      ).reasonCategory,
    ).toBe('NOT_AS_DESCRIBED');
    expect(
      parseDisputeEvent(disputeEvent({ reason: 'UNAUTHORISED' }))
        .reasonCategory,
    ).toBe('UNAUTHORIZED');
    expect(
      parseDisputeEvent(disputeEvent({ reason: 'DUPLICATE_TRANSACTION' }))
        .reasonCategory,
    ).toBe('DUPLICATE');
  });

  it('deduplicates transaction references and drops empty ones', () => {
    const parsed = parseDisputeEvent(
      disputeEvent({
        sellerTransactionIds: ['MOCK-A', 'MOCK-A', 'MOCK-B'],
      }),
    );
    expect(parsed.sellerTransactionIds).toEqual(['MOCK-A', 'MOCK-B']);
  });

  it('never invents a resolution without the official outcome', () => {
    const parsed = parseDisputeEvent(
      disputeEvent({
        eventType: 'CUSTOMER.DISPUTE.RESOLVED',
        status: 'RESOLVED',
        outcome: null,
      }),
    );
    expect(parsed.resolution).toBeNull();
  });

  it.each([
    { event_type: 'PAYMENT.CAPTURE.COMPLETED' },
    { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: {} },
    {
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: {
        dispute_id: 'PP-D-MOCK',
        create_time: '2026-11-06T00:00:00Z',
        status: 'OPEN',
      },
    },
  ])('rejects malformed dispute payloads %#', (payload) => {
    expect(() =>
      parseDisputeEvent({
        id: 'MOCK-INVALID',
        create_time: '2026-11-06T00:00:00Z',
        resource: {},
        ...payload,
      }),
    ).toThrow(IngestionRejection);
  });
});
