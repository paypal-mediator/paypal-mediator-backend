import type { CreateOrder, RegisterEvidence } from '@resolve-ai/contracts';

// Explicit DEMO / MOCK commerce source. No real shipping, customer data or carrier verification.
export function demoOrder(reference: string): CreateOrder {
  return {
    externalId: `ORDER-${reference}`,
    paypalOrderId: `PP-${reference}`,
    sourceKind: 'DEMO',
    sourceSystem: 'DEMO / MOCK commerce',
    currencyCode: 'USD',
    totalAmount: '10.25',
    shippingAmount: '0',
    taxAmount: '0',
    discountAmount: '0',
    orderedAt: '2026-11-05T00:00:00Z',
    items: [
      {
        sku: 'MOCK-SKU',
        description: 'DEMO / MOCK physical item',
        quantity: 1,
        unitAmount: '10.25',
      },
    ],
  };
}

export function demoTracking(
  reference: string,
): Extract<RegisterEvidence, { type: 'TRACKING' }> {
  return {
    type: 'TRACKING',
    sourceKind: 'DEMO',
    sourceSystem: 'DEMO / MOCK carrier',
    externalReference: `SHIP-${reference}`,
    retrievedAt: '2026-11-06T03:00:00Z',
    content: {
      paypalCaptureId: `CAP-${reference}`,
      merchantOrderReference: `ORDER-${reference}`,
      carrier: 'MOCK-CARRIER',
      trackingNumber: `TRACK-${reference}`,
      shippedAt: '2026-11-06T01:00:00Z',
      status: 'IN_TRANSIT',
    },
  };
}

export function demoDelivery(
  reference: string,
): Extract<RegisterEvidence, { type: 'PROOF_OF_DELIVERY' }> {
  return {
    type: 'PROOF_OF_DELIVERY',
    sourceKind: 'DEMO',
    sourceSystem: 'DEMO / MOCK carrier',
    externalReference: `DELIVERY-${reference}`,
    retrievedAt: '2026-11-06T03:00:00Z',
    content: {
      paypalCaptureId: `CAP-${reference}`,
      merchantOrderReference: `ORDER-${reference}`,
      carrier: 'MOCK-CARRIER',
      trackingNumber: `TRACK-${reference}`,
      deliveredAt: '2026-11-06T02:00:00Z',
      status: 'DELIVERED',
    },
  };
}
