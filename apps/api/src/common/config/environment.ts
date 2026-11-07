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
const optionalString = (schema: z.ZodType<string>) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    schema.optional(),
  );
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
  TRANSACTION_WORKER_ENABLED: booleanFlag.default(false),
  DISPUTE_WORKER_ENABLED: booleanFlag.default(false),
  PAYPAL_CLIENT_ID: optionalString(z.string().trim().min(1).max(512)),
  PAYPAL_CLIENT_SECRET: optionalString(z.string().min(1).max(512)),
  PAYPAL_WEBHOOK_ID: optionalString(z.string().trim().min(1).max(512)),
  PAYPAL_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  SUPABASE_URL: optionalString(
    z.url().refine((value) => {
      try {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) && url.origin === value
        );
      } catch {
        return false;
      }
    }),
  ),
  MERCHANT_ID: optionalString(z.uuid()),
  SUPABASE_SERVICE_ROLE_KEY: optionalString(z.string().min(1).max(2048)),
  SUPABASE_SECRET_KEY: optionalString(
    z.string().regex(/^sb_secret_[A-Za-z0-9_-]+$/),
  ),
  EVIDENCE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .default('private-evidence'),
  MAX_INVESTIGATION_ROUNDS: z.coerce.number().int().min(1).max(5).default(2),
  AI_PROVIDER: z.enum(['nvidia', 'openai']).default('nvidia'),
  NVIDIA_API_KEY: optionalString(z.string().trim().min(1).max(2048)),
  NVIDIA_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .default('nvidia/nemotron-3.5-super-vl-120b-a12b'),
  OPENAI_API_KEY: optionalString(z.string().trim().min(1).max(2048)),
  OPENAI_MODEL: optionalString(z.string().trim().min(1).max(128)),
  VERIFIER_MAX_STEPS: z.coerce.number().int().min(2).max(16).default(12),
  VERIFIER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(90000),
  INVESTIGATOR_MAX_STEPS: z.coerce.number().int().min(2).max(12).default(8),
  INVESTIGATOR_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(60000),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
export const ENVIRONMENT = Symbol('ENVIRONMENT');

export function parseEnvironment(input: Record<string, unknown>): Environment {
  const result = EnvironmentSchema.safeParse({
    ...input,
    TRANSACTION_WORKER_ENABLED:
      input.TRANSACTION_WORKER_ENABLED ??
      (input.NODE_ENV === 'production' ? 'true' : 'false'),
    DISPUTE_WORKER_ENABLED:
      input.DISPUTE_WORKER_ENABLED ??
      input.TRANSACTION_WORKER_ENABLED ??
      (input.NODE_ENV === 'production' ? 'true' : 'false'),
  });
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
  if (
    Boolean(result.data.PAYPAL_CLIENT_ID) !==
    Boolean(result.data.PAYPAL_CLIENT_SECRET)
  ) {
    throw new Error(
      'Invalid environment configuration: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured together',
    );
  }
  if (
    (result.data.SUPABASE_SECRET_KEY ||
      result.data.SUPABASE_SERVICE_ROLE_KEY) &&
    !result.data.SUPABASE_URL
  ) {
    throw new Error(
      'Invalid environment configuration: SUPABASE_URL is required for Storage credentials',
    );
  }
  if (
    result.data.SUPABASE_URL?.startsWith('http:') &&
    (result.data.NODE_ENV === 'production' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(result.data.SUPABASE_URL).hostname,
      ))
  ) {
    throw new Error(
      'Invalid environment configuration: SUPABASE_URL requires HTTPS except for local development',
    );
  }
  return result.data;
}
