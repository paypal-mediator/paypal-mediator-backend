import { z } from 'zod';

const postgresUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol);
  } catch {
    return false;
  }
}, 'Expected a PostgreSQL URL');

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
const originList = z.string().transform((value, ctx) => {
  const origins = value.split(',').map((origin) => origin.trim());
  if (
    origins.some((origin) => {
      try {
        const url = new URL(origin);
        return (
          !['http:', 'https:'].includes(url.protocol) || url.origin !== origin
        );
      } catch {
        return true;
      }
    })
  ) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Expected comma-separated HTTP origins without paths or wildcards',
    });
    return z.NEVER;
  }
  return origins;
});

export const EnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGIN: originList.default(['http://localhost:3000']),
  DATABASE_URL: postgresUrl,
  DB_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30000)
    .default(3000),
  SWAGGER_ENABLED: booleanFlag.optional(),
  PAYPAL_ENV: z.literal('sandbox').default('sandbox'),
  MAX_INVESTIGATION_ROUNDS: z.coerce.number().int().min(1).max(5).default(2),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
export const ENVIRONMENT = Symbol('ENVIRONMENT');

export function parseEnvironment(input: Record<string, unknown>): Environment {
  const result = EnvironmentSchema.safeParse(input);
  if (!result.success) {
    // Report only field names: credentials and connection URLs must never enter logs.
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  if (
    result.data.NODE_ENV === 'production' &&
    input.CORS_ORIGIN === undefined
  ) {
    throw new Error(
      'Invalid environment configuration: CORS_ORIGIN is required in production',
    );
  }
  return result.data;
}
