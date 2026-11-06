import 'reflect-metadata';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { parseEnvironment } from '../common/config/environment.js';
import { EvidenceStorage } from '../modules/evidence/evidence-storage.js';

config({
  path: fileURLToPath(new URL('../../../../.env', import.meta.url)),
  quiet: true,
});
try {
  const storage = new EvidenceStorage(parseEnvironment(process.env));
  console.log(JSON.stringify(await storage.setupBucket()));
} catch {
  // Credentials and provider responses must never reach command output.
  console.error(
    'Evidence Storage setup failed. Check server credentials and private bucket configuration.',
  );
  process.exitCode = 1;
}
