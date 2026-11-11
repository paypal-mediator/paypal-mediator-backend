import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { createApp } from './application.js';

if (process.env.NODE_ENV !== 'production') {
  config({
    path: fileURLToPath(new URL('../../../.env', import.meta.url)),
    quiet: true,
  });
}

async function bootstrap() {
  const { app, environment } = await createApp();

  console.log(`[BOOT] NODE_ENV=${process.env.NODE_ENV}`);
  console.log(`[BOOT] PORT from env: ${process.env.PORT}`);
  console.log(`[BOOT] PORT from schema: ${environment.PORT}`);
  console.log(`[BOOT] Starting server on 0.0.0.0:${environment.PORT}`);

  await app.listen(environment.PORT, '0.0.0.0');
  console.log(`[BOOT] Server listening on port ${environment.PORT}`);
}

bootstrap().catch((error) => {
  console.error('[BOOT] Failed to start server:', error);
  process.exit(1);
});
