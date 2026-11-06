import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseAuthService } from '../../src/modules/merchants/auth/supabase-auth.service.js';
import { parseEnvironment } from '../../src/common/config/environment.js';
import { createMockAuth } from '../fixtures/auth.js';

describe('Supabase JWT verification (MOCK issuer, real asymmetric signatures)', () => {
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let service: SupabaseAuthService;
  const userId = randomUUID();
  beforeAll(async () => {
    issuer = await createMockAuth();
    service = new SupabaseAuthService(
      parseEnvironment({
        DATABASE_URL: 'postgresql://localhost/test',
        NODE_ENV: 'test',
        SUPABASE_URL: issuer.origin,
      }),
    );
  });
  afterAll(async () => {
    await issuer?.close();
  });

  it('validates signatures via JWKS and returns the authenticated user UUID', async () => {
    expect(
      await service.authenticate(`Bearer ${await issuer.token(userId)}`),
    ).toBe(userId);
  });
  it.each([undefined, '', 'Basic secret', 'Bearer not-a-jwt'])(
    'rejects absent or malformed authorization %s',
    async (header) => {
      await expect(service.authenticate(header)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    },
  );
  it.each([
    { exp: 1 },
    { iss: 'https://another-project.example/auth/v1' },
    { aud: 'anon' },
    { role: 'service_role' },
    { is_anonymous: true },
  ])('rejects invalid or unauthorized claims %j', async (claims) => {
    await expect(
      service.authenticate(`Bearer ${await issuer.token(userId, claims)}`),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('rejects a JWT signed by another key even with matching claims', async () => {
    const attacker = await createMockAuth();
    try {
      const token = await attacker.token(userId, {
        iss: `${issuer.origin}/auth/v1`,
      });
      await expect(
        service.authenticate(`Bearer ${token}`),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    } finally {
      await attacker.close();
    }
  });
  it('fails closed when authentication is unconfigured', async () => {
    const unconfigured = new SupabaseAuthService(
      parseEnvironment({ DATABASE_URL: 'postgresql://localhost/test' }),
    );
    await expect(
      unconfigured.authenticate('Bearer fake'),
    ).rejects.toMatchObject({ code: 'AUTH_NOT_CONFIGURED' });
  });
});
