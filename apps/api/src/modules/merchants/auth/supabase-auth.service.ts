import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import {
  ENVIRONMENT,
  type Environment,
} from '../../../common/config/environment.js';
import { ApiException } from '../../../common/http/api.exception.js';

const UserClaimsSchema = z.object({
  sub: z.uuid(),
  role: z.literal('authenticated'),
  is_anonymous: z.boolean().optional(),
});

@Injectable()
export class SupabaseAuthService {
  private readonly issuer: string | undefined;
  private readonly keys: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(@Inject(ENVIRONMENT) private readonly environment: Environment) {
    this.issuer = environment.SUPABASE_URL
      ? `${environment.SUPABASE_URL}/auth/v1`
      : undefined;
    this.keys = this.issuer
      ? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`), {
          timeoutDuration: 5000,
          cooldownDuration: 30000,
          cacheMaxAge: 600000,
        })
      : undefined;
  }

  async identity(authorization: string | undefined) {
    const userId = await this.authenticate(authorization);
    const key =
      this.environment.SUPABASE_SECRET_KEY ??
      this.environment.SUPABASE_SERVICE_ROLE_KEY;
    if (!key)
      throw new ApiException(
        'AUTH_IDENTITY_UNAVAILABLE',
        'Verified identity lookup is not configured',
        503,
      );
    let profile: unknown;
    try {
      const response = await fetch(`${this.issuer}/user`, {
        headers: { authorization: authorization!, apikey: key },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Identity lookup failed');
      profile = await response.json();
    } catch {
      throw new ApiException(
        'AUTH_IDENTITY_UNAVAILABLE',
        'Unable to verify the current account email',
        503,
      );
    }
    const parsed = z
      .object({
        id: z.uuid(),
        email: z.email(),
        email_confirmed_at: z.iso.datetime({ offset: true }).nullable(),
      })
      .safeParse(profile);
    if (
      !parsed.success ||
      parsed.data.id !== userId ||
      !parsed.data.email_confirmed_at
    )
      throw new ApiException(
        'VERIFIED_EMAIL_REQUIRED',
        'Confirm your account email before using invitations',
        403,
      );
    return { userId, email: parsed.data.email.trim().toLowerCase() };
  }

  async authenticate(authorization: string | undefined): Promise<string> {
    if (
      !authorization ||
      !/^Bearer \S+$/i.test(authorization) ||
      authorization.length > 16384
    ) {
      throw new ApiException(
        'UNAUTHENTICATED',
        'A valid user access token is required',
        401,
      );
    }
    if (!this.keys || !this.issuer) {
      throw new ApiException(
        'AUTH_NOT_CONFIGURED',
        'User authentication is not configured',
        503,
      );
    }
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.keys, {
        issuer: this.issuer,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256'],
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
      });
      const claims = UserClaimsSchema.parse(payload);
      if (claims.is_anonymous === true)
        throw new Error('Anonymous users cannot access merchant data');
      return claims.sub;
    } catch {
      // Neither untrusted claims nor JOSE errors may be returned or logged.
      throw new ApiException(
        'UNAUTHENTICATED',
        'A valid user access token is required',
        401,
      );
    }
  }
}
