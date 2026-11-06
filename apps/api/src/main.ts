import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { createApp } from './application.js';

config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});

try {
  const { app, environment } = await createApp();
  await app.listen(environment.PORT, '0.0.0.0');
} catch (error) {
  // Never print arbitrary connection/initialization errors with credentials.
  const message =
    error instanceof Error &&
    error.message.startsWith('Invalid environment configuration:')
      ? error.message
      : 'API startup failed';
  console.error(message);
  process.exitCode = 1;
}
