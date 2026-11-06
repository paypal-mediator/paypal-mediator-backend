import { describe, expect, it } from 'vitest';
import {
  CreateOrderSchema,
  RegisterEvidenceSchema,
  UploadEvidenceFileSchema,
} from '@resolve-ai/contracts';
import { contentHash } from '../../src/common/data/content-hash.js';
import { demoOrder, demoTracking } from '../fixtures/commerce.js';

describe('Commerce/evidence public contracts', () => {
  const file = {
    sourceKind: 'DEMO',
    sourceSystem: 'DEMO / MOCK documents',
    externalReference: 'DEMO-PDF',
    retrievedAt: '2026-11-05T00:00:00Z',
    fileName: 'demo.pdf',
    mediaType: 'application/pdf',
    dataBase64: Buffer.from('%PDF-DEMO').toString('base64'),
  };
  it.each([
    { sourceKind: 'PAYPAL' },
    { verified: true },
    { merchantId: 'CLIENT-CHOSEN' },
    { fileName: '../secret.pdf' },
    { fileName: 'a\r\nInjected.pdf' },
    { mediaType: 'text/html' },
    { dataBase64: '!!!!' },
  ])('rejects invalid file input or client-chosen provenance %j', (invalid) => {
    expect(
      UploadEvidenceFileSchema.safeParse({ ...file, ...invalid }).success,
    ).toBe(false);
  });
  it('rejects file payloads above the encoded size limit', () => {
    expect(
      UploadEvidenceFileSchema.safeParse({
        ...file,
        dataBase64: 'A'.repeat(4 * Math.ceil((512 * 1024) / 3) + 4),
      }).success,
    ).toBe(false);
  });
  it('hashes equivalent JSON consistently after PostgreSQL reorders object keys', () => {
    expect(contentHash({ first: 'a', nested: { x: 1, y: [true, null] } })).toBe(
      contentHash({ nested: { y: [true, null], x: 1 }, first: 'a' }),
    );
    expect(contentHash({ items: ['a', 'b'] })).not.toBe(
      contentHash({ items: ['b', 'a'] }),
    );
    expect(contentHash({ value: '1.00' })).not.toBe(
      contentHash({ value: '100.00' }),
    );
  });
  it('requires explicit source provenance and rejects authorization/verification fields in input', () => {
    expect(
      CreateOrderSchema.safeParse({
        ...demoOrder('CONTRACT'),
        sourceKind: undefined,
      }).success,
    ).toBe(false);
    expect(
      CreateOrderSchema.safeParse({
        ...demoOrder('CONTRACT'),
        merchantId: 'CLIENT-CHOSEN',
      }).success,
    ).toBe(false);
    expect(
      RegisterEvidenceSchema.safeParse({
        ...demoTracking('CONTRACT'),
        verified: true,
      }).success,
    ).toBe(false);
    expect(
      RegisterEvidenceSchema.safeParse({
        ...demoTracking('CONTRACT'),
        sourceKind: 'PAYPAL',
      }).success,
    ).toBe(false);
  });
  it.each(['-1', '1e3', '10000000000000000', '0.123456789'])(
    'rejects unsupported order amounts %s',
    (value) => {
      expect(
        CreateOrderSchema.safeParse({
          ...demoOrder('CONTRACT'),
          totalAmount: value,
        }).success,
      ).toBe(false);
    },
  );
  it('requires structured tracking data instead of an arbitrary filename or image claim', () => {
    expect(
      RegisterEvidenceSchema.safeParse({
        ...demoTracking('CONTRACT'),
        content: { file: 'receipt.png' },
      }).success,
    ).toBe(false);
  });
});
