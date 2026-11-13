import { mockWebhookEvent } from './paypal-webhook.js';

// DEMO / MOCK payment; not a genuine PayPal event.
export function captureEvent(captureId = 'MOCK-CAPTURE') {
  return {
    ...mockWebhookEvent(),
    resource: {
      id: captureId,
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '10.25' },
      create_time: '2026-11-06T00:00:00Z',
      custom_id: 'MOCK-MERCHANT-ORDER',
      supplementary_data: { related_ids: { order_id: 'MOCK-ORDER' } },
    },
  };
}

// Native Payments v2 refund resource, adapted to Sandbox. All values are MOCK.
export function paymentAdjustmentEvent(
  captureId: string,
  adjustmentId: string,
  amount = '2.10',
  cumulative = amount,
  reversed = false,
) {
  return {
    ...mockWebhookEvent(
      reversed ? 'PAYMENT.CAPTURE.REVERSED' : 'PAYMENT.CAPTURE.REFUNDED',
    ),
    resource_type: 'refund',
    resource_version: '2.0',
    resource: {
      id: adjustmentId,
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: amount },
      create_time: '2026-11-06T00:01:00Z',
      seller_payable_breakdown: {
        total_refunded_amount: { currency_code: 'USD', value: cumulative },
      },
      links: [
        {
          rel: 'up',
          method: 'GET',
          href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`,
        },
      ],
    },
  };
}
