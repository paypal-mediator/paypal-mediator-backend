import { describe, expect, it } from 'vitest';
import {
  ingestionJobKind,
  parseTransmissionHeaders,
  parseWebhookBody,
  webhookHashes,
} from '../../src/modules/event-ingestion/webhook-validation.js';
import {
  mockTransmissionHeaders,
  mockWebhookEvent,
} from '../fixtures/paypal-webhook.js';

describe('M02 webhook validation and routing (MOCK inputs)', () => {
  it('keeps unknown original envelope and resource fields', () => {
    const event = { ...mockWebhookEvent(), extra_paypal_field: { kept: true } };
    expect(parseWebhookBody(Buffer.from(JSON.stringify(event)))).toEqual(event);
    expect(parseTransmissionHeaders(mockTransmissionHeaders).auth_algo).toBe(
      'SHA256withRSA',
    );
  });
  it('preserves original property order for PayPal signature verification', () => {
    const event = mockWebhookEvent();
    const original = JSON.stringify({
      id: event.id,
      event_version: '1.0',
      create_time: event.create_time,
      resource_type: 'capture',
      event_type: event.event_type,
      summary: event.summary,
      resource: event.resource,
      resource_version: '2.0',
    });
    expect(JSON.stringify(parseWebhookBody(Buffer.from(original)))).toBe(
      original,
    );
  });
  it.each([
    {},
    { ...mockTransmissionHeaders, 'paypal-auth-algo': 'none' },
    {
      ...mockTransmissionHeaders,
      'paypal-cert-url': 'http://127.0.0.1/private',
    },
    {
      ...mockTransmissionHeaders,
      'paypal-cert-url':
        'https://api.sandbox.paypal.com.attacker.example/v1/notifications/certs/CERT-1',
    },
    {
      ...mockTransmissionHeaders,
      'paypal-cert-url':
        'https://user:password@api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    },
    {
      ...mockTransmissionHeaders,
      'paypal-transmission-id': ['first', 'second'],
    },
  ])('rejects missing, malformed or untrusted headers', (headers) => {
    expect(() => parseTransmissionHeaders(headers)).toThrow(
      'Valid PayPal transmission headers',
    );
  });
  it.each([
    undefined,
    Buffer.from('{invalid'),
    Buffer.from('{}'),
    Buffer.from('{"id":"MOCK"}'),
  ])('rejects invalid bodies without exposing inputs', (body) => {
    expect(() => parseWebhookBody(body)).toThrow();
  });
  it('distinguishes raw-byte integrity from canonical payload identity', () => {
    const event = mockWebhookEvent();
    const original = Buffer.from(JSON.stringify(event));
    const reordered = Buffer.from(
      JSON.stringify(
        {
          summary: event.summary,
          resource: event.resource,
          create_time: event.create_time,
          id: event.id,
          event_version: event.event_version,
          event_type: event.event_type,
        },
        null,
        2,
      ),
    );
    const first = webhookHashes(parseWebhookBody(original), original);
    const second = webhookHashes(parseWebhookBody(reordered), reordered);
    expect(first.payloadHash).toBe(second.payloadHash);
    expect(first.rawBodyHash).not.toBe(second.rawBodyHash);
  });
  it.each([
    ['PAYMENT.CAPTURE.COMPLETED', 'TRANSACTION_CAPTURED'],
    ['CUSTOMER.DISPUTE.CREATED', 'DISPUTE_CHANGED'],
    ['CUSTOMER.DISPUTE.UPDATED', 'DISPUTE_CHANGED'],
    ['CUSTOMER.DISPUTE.RESOLVED', 'DISPUTE_CHANGED'],
    ['PAYMENT.CAPTURE.PENDING', null],
  ])('maps %s to %s without starting a consumer', (eventType, kind) => {
    expect(ingestionJobKind(eventType)).toBe(kind);
  });
});
