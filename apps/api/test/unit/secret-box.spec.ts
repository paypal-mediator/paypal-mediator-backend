import { describe, it, expect } from 'vitest';
import {
  encryptErpSecret,
  decryptErpSecret,
  generateMasterKey,
} from '../../src/common/crypto/secret-box.js';
import type { Environment } from '../../src/common/config/environment.js';

const TEST_ENV: Environment = {
  MASTER_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  NODE_ENV: 'test',
  PORT: 3001,
  CORS_ORIGIN: ['http://localhost:3000'],
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/resolve_ai',
  DB_CONNECTION_TIMEOUT_MS: 3000,
  SWAGGER_ENABLED: true,
  PAYPAL_ENV: 'sandbox',
  TRANSACTION_WORKER_ENABLED: false,
  DISPUTE_WORKER_ENABLED: false,
  PAYPAL_TIMEOUT_MS: 5000,
  SEVENTEENTRACK_TIMEOUT_MS: 10000,
  SEVENTEENTRACK_WEBHOOK_ENABLED: false,
  SEVENTEENTRACK_DAILY_REGISTRATION_LIMIT: 100,
  SEVENTEENTRACK_DAILY_REQUEST_LIMIT: 1000,
  SHIPMENT_TRACKING_WORKER_ENABLED: false,
  SHIPMENT_TRACKING_CACHE_SECONDS: 21600,
  SHIPMENT_TRACKING_FRESH_HOURS: 72,
  SUPABASE_URL: 'http://localhost:54321',
  MERCHANT_ID: '00000000-0000-0000-0000-000000000000',
  EVIDENCE_BUCKET: 'private-evidence',
  MAX_INVESTIGATION_ROUNDS: 2,
  AI_PROVIDER: 'nvidia',
  NVIDIA_MODEL: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  VERIFIER_MAX_STEPS: 12,
  VERIFIER_TIMEOUT_MS: 90000,
  INVESTIGATOR_MAX_STEPS: 8,
  INVESTIGATOR_TIMEOUT_MS: 60000,
};

describe('secret-box encryption', () => {
  it('should encrypt and decrypt Bind ERP payload', async () => {
    const payload = {
      apiKey: 'bind_test_api_key_12345',
      baseUrl: 'https://api.bind.com.mx',
      subscriptionKey: 'sub_key_abc',
    };

    const encrypted = await encryptErpSecret(payload, TEST_ENV);
    expect(typeof encrypted).toBe('string');
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = await decryptErpSecret(encrypted, TEST_ENV);
    expect(decrypted.apiKey).toBe(payload.apiKey);
    expect(decrypted.baseUrl).toBe(payload.baseUrl);
    expect(decrypted.subscriptionKey).toBe(payload.subscriptionKey);
  });

  it('should encrypt and decrypt Siigo payload', async () => {
    const payload = {
      apiKey: 'siigo_username',
      baseUrl: 'https://api.siigo.mx/v1',
      username: 'user@company.com',
      accessKey: 'access_key_123',
    };

    const encrypted = await encryptErpSecret(payload, TEST_ENV);
    const decrypted = await decryptErpSecret(encrypted, TEST_ENV);

    expect(decrypted.apiKey).toBe(payload.apiKey);
    expect(decrypted.username).toBe(payload.username);
    expect(decrypted.accessKey).toBe(payload.accessKey);
  });

  it('should encrypt and decrypt Odoo payload', async () => {
    const payload = {
      apiKey: 'odoo_api_key_123',
      baseUrl: 'https://mycompany.odoo.com',
      database: 'mycompany_db',
    };

    const encrypted = await encryptErpSecret(payload, TEST_ENV);
    const decrypted = await decryptErpSecret(encrypted, TEST_ENV);

    expect(decrypted.apiKey).toBe(payload.apiKey);
    expect(decrypted.baseUrl).toBe(payload.baseUrl);
    expect(decrypted.database).toBe(payload.database);
  });

  it('should encrypt and decrypt ERPNext payload', async () => {
    const payload = {
      apiKey: 'erpnext_api_key',
      apiSecret: 'erpnext_api_secret',
      baseUrl: 'https://mycompany.erpnext.com',
    };

    const encrypted = await encryptErpSecret(payload, TEST_ENV);
    const decrypted = await decryptErpSecret(encrypted, TEST_ENV);

    expect(decrypted.apiKey).toBe(payload.apiKey);
    expect(decrypted.apiSecret).toBe(payload.apiSecret);
    expect(decrypted.baseUrl).toBe(payload.baseUrl);
  });

  it('should produce different ciphertext for same payload (nonce randomization)', async () => {
    const payload = { apiKey: 'test_key', baseUrl: 'https://test.com' };

    const encrypted1 = await encryptErpSecret(payload, TEST_ENV);
    const encrypted2 = await encryptErpSecret(payload, TEST_ENV);

    expect(encrypted1).not.toBe(encrypted2);

    // Both should decrypt to same payload
    const decrypted1 = await decryptErpSecret(encrypted1, TEST_ENV);
    const decrypted2 = await decryptErpSecret(encrypted2, TEST_ENV);
    expect(decrypted1).toEqual(decrypted2);
    expect(decrypted1).toEqual(payload);
  });

  it('should fail decryption with wrong master key', async () => {
    const payload = { apiKey: 'test_key' };
    const encrypted = await encryptErpSecret(payload, TEST_ENV);

    const wrongEnv: Environment = {
      ...TEST_ENV,
      MASTER_ENCRYPTION_KEY: 'BBECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    };

    await expect(decryptErpSecret(encrypted, wrongEnv)).rejects.toThrow(
      'wrong secret key',
    );
  });

  it('should handle legacy unencrypted payload (backward compatibility)', async () => {
    const legacyPayload = JSON.stringify({
      apiKey: 'legacy_key',
      baseUrl: 'https://legacy.com',
    });

    const decrypted = await decryptErpSecret(legacyPayload, TEST_ENV);
    expect(decrypted.apiKey).toBe('legacy_key');
    expect(decrypted.baseUrl).toBe('https://legacy.com');
  });

  it('should generate valid master key', async () => {
    const key = await generateMasterKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBe(44); // 32 bytes base64 = 44 chars

    // Should be valid base64
    expect(() => Buffer.from(key, 'base64')).not.toThrow();
    expect(Buffer.from(key, 'base64').length).toBe(32);
  });
});
