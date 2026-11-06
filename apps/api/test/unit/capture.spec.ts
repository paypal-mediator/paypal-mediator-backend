import { describe, expect, it } from 'vitest';
import { parseCapture } from '../../src/modules/transactions/capture.js';
import { TransactionQuerySchema } from '@resolve-ai/contracts';
import { captureEvent } from '../fixtures/capture.js';

describe('M03 capture normalization (DEMO / MOCK)', () => {
  it('preserves exact decimal amounts and explicit order references', () => {
    expect(parseCapture(captureEvent())).toMatchObject({
      paypalCaptureId: 'MOCK-CAPTURE',
      amount: '10.25',
      currencyCode: 'USD',
      paypalOrderId: 'MOCK-ORDER',
      merchantOrderReference: 'MOCK-MERCHANT-ORDER',
    });
  });
  it('does not invent missing order references', () => {
    const event = captureEvent();
    const resource = {
      id: event.resource.id,
      status: event.resource.status,
      amount: event.resource.amount,
      create_time: event.resource.create_time,
    };
    expect(parseCapture({ ...event, resource })).toMatchObject({
      paypalOrderId: null,
      merchantOrderReference: null,
    });
  });
  it.each([
    '0',
    '-1',
    '1e3',
    'NaN',
    '1.123456789',
    '10000000000000000',
    '01.00',
  ])('rejects invalid amount %s', (value) => {
    const event = captureEvent();
    event.resource.amount.value = value;
    expect(() => parseCapture(event)).toThrow('INVALID_CAPTURE');
  });
  it.each(['PENDING', 'REFUNDED'])('rejects capture status %s', (status) => {
    const event = captureEvent();
    event.resource.status = status;
    expect(() => parseCapture(event)).toThrow('INVALID_CAPTURE');
  });
  it('rejects unrelated event types and incomplete payloads', () => {
    expect(() =>
      parseCapture({
        ...captureEvent(),
        event_type: 'CUSTOMER.DISPUTE.CREATED',
      }),
    ).toThrow('INVALID_CAPTURE');
    expect(() => parseCapture({})).toThrow('INVALID_CAPTURE');
  });
  it('bounds pagination and rejects malformed filters', () => {
    expect(TransactionQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(TransactionQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(TransactionQuerySchema.safeParse({ pageSize: 101 }).success).toBe(
      false,
    );
    expect(
      TransactionQuerySchema.safeParse({ paypalCaptureId: [] }).success,
    ).toBe(false);
  });
});
