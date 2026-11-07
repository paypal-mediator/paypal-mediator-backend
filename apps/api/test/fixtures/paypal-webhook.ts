import { randomUUID } from 'node:crypto';

// DEMO / MOCK data. These headers and events are not genuine PayPal signatures.
export const mockTransmissionHeaders = {
  'paypal-transmission-id': 'MOCK-TRANSMISSION',
  'paypal-transmission-time': '2026-11-06T00:00:00Z',
  'paypal-transmission-sig': 'TU9DS19TSUdOQVRVUkU=',
  'paypal-cert-url':
    'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-MOCK',
  'paypal-auth-algo': 'SHA256withRSA',
};

// DEMO / MOCK dispute resource. Shapes follow PayPal's documented fields but
// the values are fabricated for tests only.
export function mockDisputeResource() {
  return {
    dispute_id: 'PP-D-MOCK',
    create_time: '2026-11-06T00:00:00Z',
    update_time: '2026-11-06T00:00:00Z',
    status: 'OPEN',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    dispute_life_cycle_stage: 'INQUIRY',
    dispute_amount: { currency_code: 'USD', value: '10.25' },
    seller_response_due_date: '2026-11-20T00:00:00Z',
    disputed_transactions: [
      {
        seller_transaction_id: 'MOCK-CAPTURE',
        buyer_transaction_id: 'MOCK-BUYER',
        gross_amount: { currency_code: 'USD', value: '10.25' },
      },
    ],
  };
}

export function mockWebhookEvent(eventType = 'PAYMENT.CAPTURE.COMPLETED') {
  return {
    id: `MOCK-${randomUUID()}`,
    event_type: eventType,
    create_time: '2026-11-06T00:00:00Z',
    resource: eventType.startsWith('CUSTOMER.DISPUTE.')
      ? { ...mockDisputeResource(), source: 'DEMO / MOCK' }
      : { id: 'MOCK-CAPTURE', source: 'DEMO / MOCK' },
    summary: 'DEMO / MOCK webhook event',
    event_version: '1.0',
  };
}
