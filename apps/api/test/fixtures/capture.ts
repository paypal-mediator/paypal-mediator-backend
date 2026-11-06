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
