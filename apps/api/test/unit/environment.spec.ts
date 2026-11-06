import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../../src/common/config/environment.js';

const base = {
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/resolve_ai',
};

describe('environment validation', () => {
  it('enables the capture worker in production and respects an explicit override', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://merchant.example',
    };
    expect(parseEnvironment(production).TRANSACTION_WORKER_ENABLED).toBe(true);
    expect(
      parseEnvironment({ ...production, TRANSACTION_WORKER_ENABLED: 'false' })
        .TRANSACTION_WORKER_ENABLED,
    ).toBe(false);
    expect(parseEnvironment(base).TRANSACTION_WORKER_ENABLED).toBe(false);
    expect(
      parseEnvironment({ ...base, NODE_ENV: 'test' })
        .TRANSACTION_WORKER_ENABLED,
    ).toBe(false);
  });
  it('applies safe defaults and parses explicit false', () => {
    expect(
      parseEnvironment({ ...base, SWAGGER_ENABLED: 'false' }),
    ).toMatchObject({
      PORT: 3001,
      PAYPAL_ENV: 'sandbox',
      SWAGGER_ENABLED: false,
      CORS_ORIGIN: ['http://localhost:3000'],
    });
  });

  it.each([
    { SUPABASE_SECRET_KEY: 'sb_publishable_MOCK_NOT_PRIVILEGED' },
    { SUPABASE_SECRET_KEY: 'sb_secret_MOCK_WITHOUT_PROJECT_URL' },
    { PORT: '0' },
    { PORT: 'abc' },
    { DATABASE_URL: 'https://example.com' },
    { CORS_ORIGIN: '*' },
    { CORS_ORIGIN: 'https://example.com/path' },
    { CORS_ORIGIN: '' },
    { PAYPAL_ENV: 'live' },
    { SWAGGER_ENABLED: 'yes' },
    { TRANSACTION_WORKER_ENABLED: 'yes' },
    { DB_CONNECTION_TIMEOUT_MS: '0' },
    { MAX_INVESTIGATION_ROUNDS: '100' },
    { SUPABASE_URL: 'not-a-url' },
    { SUPABASE_URL: 'https://project.supabase.co/auth/v1' },
    { SUPABASE_URL: 'http://untrusted.example' },
    { MERCHANT_ID: 'not-a-uuid' },
    { PAYPAL_CLIENT_ID: 'MOCK_CLIENT_WITHOUT_SECRET' },
    { PAYPAL_TIMEOUT_MS: '0' },
  ])('rejects invalid configuration %j', (invalid) => {
    expect(() => parseEnvironment({ ...base, ...invalid })).toThrow(
      'Invalid environment configuration',
    );
  });

  it('requires explicit production origins and accepts multiple exact origins', () => {
    expect(() => parseEnvironment({ ...base, NODE_ENV: 'production' })).toThrow(
      'CORS_ORIGIN',
    );
    expect(
      parseEnvironment({
        ...base,
        CORS_ORIGIN: 'https://one.example, https://two.example',
      }).CORS_ORIGIN,
    ).toEqual(['https://one.example', 'https://two.example']);
  });

  it('does not disclose invalid environment values', () => {
    expect(() =>
      parseEnvironment({ DATABASE_URL: 'private-secret-value' }),
    ).toThrow(/^Invalid environment configuration: DATABASE_URL$/);
    expect(() => parseEnvironment({})).toThrow('DATABASE_URL');
  });
});
