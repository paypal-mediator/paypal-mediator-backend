import { describe, expect, it } from 'vitest';
import { paypalRefundCaptureId } from '@resolve-ai/contracts';
import { parsePaymentAdjustment } from '../../src/modules/transactions/payment-adjustment.js';
import { paymentAdjustmentEvent } from '../fixtures/capture.js';

describe('Payments v2 refund normalization (MOCK)', () => {
  it('extracts a native up-link capture ID without confusing it with the refund ID', () => {
    const event = paymentAdjustmentEvent('MOCK-CAPTURE', 'MOCK-REFUND');
    expect(parsePaymentAdjustment(event)).toMatchObject({
      paypalCaptureId: 'MOCK-CAPTURE',
      paypalAdjustmentId: 'MOCK-REFUND',
      kind: 'REFUND',
      amount: '2.10',
    });
  });
  it.each(['0', '-1', '1e2', '1.123456789', '99999999999999999', 'NaN'])(
    'rejects invalid money %s',
    (value) => {
      const event = paymentAdjustmentEvent('MOCK-CAPTURE', 'MOCK-REFUND');
      event.resource.amount.value = value;
      expect(() => parsePaymentAdjustment(event)).toThrow(
        'INVALID_PAYMENT_ADJUSTMENT',
      );
    },
  );
  it.each(['PENDING', 'FAILED', 'CANCELLED'])(
    'does not count a %s refund as returned money',
    (status) => {
      const event = paymentAdjustmentEvent('MOCK-CAPTURE', 'MOCK-REFUND');
      event.resource.status = status;
      expect(() => parsePaymentAdjustment(event)).toThrow(
        'INVALID_PAYMENT_ADJUSTMENT',
      );
    },
  );
  it.each([
    'http://api-m.sandbox.paypal.com/v2/payments/captures/X',
    'https://evil.example/v2/payments/captures/X',
    'https://api-m.sandbox.paypal.com@evil.example/v2/payments/captures/X',
    'https://api-m.sandbox.paypal.com/v2/payments/captures/X?next=Y',
    'https://api-m.paypal.com/v2/payments/captures/X',
  ])('rejects an untrusted or non-Sandbox reference %s', (href) => {
    expect(paypalRefundCaptureId({ links: [{ rel: 'up', href }] })).toBeNull();
  });
  it('rejects contradictory capture identifiers', () => {
    const event = paymentAdjustmentEvent('MOCK-CAPTURE', 'MOCK-REFUND');
    expect(
      paypalRefundCaptureId({
        ...event.resource,
        supplementary_data: { related_ids: { capture_id: 'OTHER' } },
      }),
    ).toBeNull();
  });
});
