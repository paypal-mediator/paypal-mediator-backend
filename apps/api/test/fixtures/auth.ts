import { createServer, type Server } from 'node:http';
import {
  decodeJwt,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from 'jose';

// MOCK identity provider only for tests; real crypto and real JWKS HTTP lookup.
export async function createMockAuth() {
  const profiles = new Map<
    string,
    { email: string; email_confirmed_at: string | null }
  >();
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: 'mock-auth-key',
    alg: 'ES256',
    use: 'sig',
  };
  const server: Server = createServer((req, res) => {
    if (req.url === '/auth/v1/user') {
      try {
        const id = decodeJwt((req.headers.authorization ?? '').slice(7)).sub!;
        const profile = profiles.get(id);
        if (!profile) {
          res.writeHead(401).end();
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ id, ...profile }));
        return;
      } catch {
        res.writeHead(401).end();
        return;
      }
    }
    if (req.url !== '/auth/v1/.well-known/jwks.json') {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Mock auth failed to listen');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    profiles,
    origin,
    async token(userId: string, overrides: JWTPayload = {}) {
      return new SignJWT({
        role: 'authenticated',
        is_anonymous: false,
        ...overrides,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'mock-auth-key' })
        .setIssuer(
          typeof overrides.iss === 'string'
            ? overrides.iss
            : `${origin}/auth/v1`,
        )
        .setAudience(overrides.aud ?? 'authenticated')
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime(overrides.exp ?? '5m')
        .sign(privateKey);
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
