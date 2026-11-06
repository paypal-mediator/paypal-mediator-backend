import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';
import { fileURLToPath } from 'node:url';

config({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
  quiet: true,
});

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Placeholder permits generation/validation without secrets; never used by the API.
    url:
      process.env.DIRECT_URL ??
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/resolve_ai?schema=public',
  },
});
