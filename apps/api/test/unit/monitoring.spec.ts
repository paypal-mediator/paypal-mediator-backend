import { describe, expect, it } from 'vitest';
import { ActivityQuerySchema, AuditWriteSchema } from '@resolve-ai/contracts';
import { randomUUID } from 'node:crypto';

describe('M09 public contracts', () => {
  it('rejects unbounded pages and incomplete cursors', () => {
    for (const value of [
      { limit: 101 },
      { limit: 0 },
      { beforeId: randomUUID() },
      { before: 'invalid' },
      { module: 'M07' },
      { from: '2026-11-08T00:00:00Z', to: '2026-11-07T00:00:00Z' },
      { outcome: 'SUBMITTED' },
    ]) {
      expect(ActivityQuerySchema.safeParse(value).success).toBe(false);
    }
    expect(ActivityQuerySchema.parse({}).limit).toBe(20);
  });
  it('rejects secrets and arbitrary payloads instead of persisting them', () => {
    const value = {
      merchantId: randomUUID(),
      actorUserId: randomUUID(),
      record: {
        action: 'SETTINGS_UPDATED',
        details: { displayNameChanged: false, token: 'MOCK_SECRET' },
      },
    };
    expect(AuditWriteSchema.safeParse(value).success).toBe(false);
  });
});
