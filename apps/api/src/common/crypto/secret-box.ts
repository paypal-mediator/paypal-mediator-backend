import sodium from 'libsodium-wrappers';
import type { Environment } from '../config/environment.js';

let sodiumReady: Promise<typeof sodium> | null = null;

function getSodium() {
  if (!sodiumReady) {
    sodiumReady = sodium.ready.then(() => sodium);
  }
  return sodiumReady;
}

export interface EncryptedPayload {
  v: number; // Version del formato de encriptación
  nonce: string; // Base64 nonce
  ciphertext: string; // Base64 ciphertext
}

export interface ErpSecretPayload {
  apiKey: string;
  baseUrl?: string;
  // Campos específicos por provider (opcional)
  subscriptionKey?: string; // Bind ERP
  username?: string; // Siigo
  accessKey?: string; // Siigo
  accessToken?: string; // Siigo (cached)
  tokenExpiresAt?: string; // Siigo (cached)
  apiSecret?: string; // ERPNext/Odoo
  database?: string; // Odoo
}

/**
 * Encripta un payload de secretos ERP usando XChaCha20-Poly1305 (libsodium)
 * Formato: v=1 | nonce (24 bytes) | ciphertext
 */
export async function encryptErpSecret(
  payload: ErpSecretPayload,
  env: Environment,
): Promise<string> {
  const sodium = await getSodium();
  const masterKeyB64 = env.MASTER_ENCRYPTION_KEY;
  if (!masterKeyB64) {
    throw new Error('MASTER_ENCRYPTION_KEY not configured');
  }
  const key = sodium.from_base64(masterKeyB64, sodium.base64_variants.ORIGINAL);
  if (key.length !== 32) {
    throw new Error('MASTER_ENCRYPTION_KEY must be 32 bytes (base64 encoded)');
  }

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = sodium.from_string(JSON.stringify(payload));
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);

  const encrypted: EncryptedPayload = {
    v: 1,
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
  };
  return JSON.stringify(encrypted);
}

/**
 * Desencripta un payload de secretos ERP
 */
export async function decryptErpSecret(
  encryptedJson: string,
  env: Environment,
): Promise<ErpSecretPayload> {
  const sodium = await getSodium();
  const masterKeyB64 = env.MASTER_ENCRYPTION_KEY;
  if (!masterKeyB64) {
    throw new Error('MASTER_ENCRYPTION_KEY not configured');
  }
  const key = sodium.from_base64(masterKeyB64, sodium.base64_variants.ORIGINAL);

  let encrypted: EncryptedPayload;
  try {
    encrypted = JSON.parse(encryptedJson);
  } catch {
    // Compatibilidad: payload legacy sin encriptar (solo string JSON)
    return JSON.parse(encryptedJson) as ErpSecretPayload;
  }

  // Verificar que sea el formato encriptado v1
  if (!encrypted || typeof encrypted !== 'object' || encrypted.v !== 1) {
    // Payload legacy (JSON plano sin encriptar)
    return JSON.parse(encryptedJson) as ErpSecretPayload;
  }

  const nonce = sodium.from_base64(
    encrypted.nonce,
    sodium.base64_variants.ORIGINAL,
  );
  const ciphertext = sodium.from_base64(
    encrypted.ciphertext,
    sodium.base64_variants.ORIGINAL,
  );

  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  if (!plaintext) {
    throw new Error('Decryption failed: invalid key or corrupted data');
  }
  return JSON.parse(sodium.to_string(plaintext)) as ErpSecretPayload;
}

/**
 * Genera una master key nueva (solo para setup inicial)
 * Ejecutar: node -e "import('libsodium-wrappers').then(s => {s.ready.then(() => console.log(s.to_base64(s.randombytes_buf(32))))})"
 */
export async function generateMasterKey(): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(
    sodium.randombytes_buf(32),
    sodium.base64_variants.ORIGINAL,
  );
}
