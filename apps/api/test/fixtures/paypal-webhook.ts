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

export function mockWebhookEvent(eventType = 'PAYMENT.CAPTURE.COMPLETED') {
  return {
    id: `MOCK-${randomUUID()}`,
    event_type: eventType,
    create_time: '2026-11-06T00:00:00Z',
    resource: eventType.startsWith('CUSTOMER.DISPUTE.')
      ? { dispute_id: 'PP-D-MOCK', source: 'DEMO / MOCK' }
      : { id: 'MOCK-CAPTURE', source: 'DEMO / MOCK' },
    summary: 'DEMO / MOCK webhook event',
    event_version: '1.0',
  };
}
