import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from '../../src/common/http/zod-validation.pipe.js';

describe('Zod HTTP validation', () => {
  const pipe = new ZodValidationPipe(
    z.strictObject({ page: z.coerce.number().int().positive() }),
  );
  it('returns parsed values', () => {
    expect(pipe.transform({ page: '2' })).toEqual({ page: 2 });
  });
  it('rejects extra keys and invalid inputs', () => {
    expect(() => pipe.transform({ page: 0 })).toThrow(
      'Request validation failed',
    );
    expect(() => pipe.transform({ page: 1, secret: 'private-value' })).toThrow(
      'Request validation failed',
    );
  });
});
