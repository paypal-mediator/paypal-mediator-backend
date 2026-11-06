import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MAX_EVIDENCE_FILE_BYTES } from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { ApiException } from '../../common/http/api.exception.js';

export function binaryHash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

@Injectable()
export class EvidenceStorage {
  constructor(@Inject(ENVIRONMENT) private readonly env: Environment) {}

  private async call(path: string, init: RequestInit = {}) {
    const key =
      this.env.SUPABASE_SECRET_KEY ?? this.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!this.env.SUPABASE_URL || !key)
      throw new ApiException(
        'EVIDENCE_STORAGE_UNAVAILABLE',
        'Evidence storage is not configured',
        503,
      );
    try {
      return await fetch(`${this.env.SUPABASE_URL}/storage/v1/${path}`, {
        ...init,
        headers: {
          ...init.headers,
          apikey: key,
          // Modern Supabase secret keys are not JWTs. Only legacy service-role
          // JWTs belong in Authorization; the gateway resolves secret apikeys.
          ...(!this.env.SUPABASE_SECRET_KEY
            ? { Authorization: `Bearer ${key}` }
            : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw this.failure();
    }
  }

  private failure() {
    return new ApiException(
      'EVIDENCE_STORAGE_FAILED',
      'Evidence storage operation failed',
      502,
    );
  }

  async setupBucket() {
    const existing = await this.call(`bucket/${this.env.EVIDENCE_BUCKET}`);
    let created = false;
    let missing = existing.status === 404;
    // Hosted Storage can report a missing bucket as HTTP 400 with an embedded
    // 404. Never interpret other 400 responses as permission to provision.
    if (existing.status === 400) {
      try {
        const error = (await existing.json()) as {
          statusCode?: string;
          error?: string;
        };
        missing =
          String(error.statusCode) === '404' &&
          error.error === 'Bucket not found';
      } catch {
        throw this.failure();
      }
    }
    if (missing) {
      const response = await this.call('bucket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: this.env.EVIDENCE_BUCKET,
          name: this.env.EVIDENCE_BUCKET,
          public: false,
          file_size_limit: MAX_EVIDENCE_FILE_BYTES,
          allowed_mime_types: ['application/pdf', 'image/png', 'image/jpeg'],
        }),
      });
      if (!response.ok && response.status !== 409) throw this.failure();
      created = response.ok;
      await response.body?.cancel().catch(() => undefined);
    } else if (!existing.ok) throw this.failure();
    if (!existing.bodyUsed)
      await existing.body?.cancel().catch(() => undefined);
    await this.ensurePrivate();
    return { bucket: this.env.EVIDENCE_BUCKET, created, private: true };
  }

  async ensurePrivate() {
    const response = await this.call(`bucket/${this.env.EVIDENCE_BUCKET}`);
    if (!response.ok) throw this.failure();
    let bucket: unknown;
    try {
      bucket = await response.json();
    } catch {
      throw this.failure();
    }
    if (
      !bucket ||
      typeof bucket !== 'object' ||
      !('public' in bucket) ||
      bucket.public !== false
    )
      throw new ApiException(
        'EVIDENCE_BUCKET_NOT_PRIVATE',
        'Evidence bucket must be private',
        503,
      );
  }

  async put(key: string, bytes: Buffer, mediaType: string) {
    await this.ensurePrivate();
    // Content-addressed keys are immutable. Never overwrite an existing original.
    const response = await this.call(
      `object/${this.env.EVIDENCE_BUCKET}/${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': mediaType, 'x-upsert': 'false' },
        body: new Uint8Array(bytes),
      },
    );
    if (!response.ok) {
      let duplicate = response.status === 409;
      if (response.status === 400) {
        try {
          const error = (await response.json()) as { error?: string };
          duplicate = error.error === 'Duplicate';
        } catch {
          /* Unrecognized storage failures are never successful uploads. */
        }
      }
      if (!duplicate) throw this.failure();
    }
    if (!response.bodyUsed)
      await response.body?.cancel().catch(() => undefined);
    // Verify read-after-write, including duplicate/conflicting responses.
    const stored = await this.get(key);
    if (binaryHash(stored) !== binaryHash(bytes))
      throw new ApiException(
        'EVIDENCE_FILE_INTEGRITY_MISMATCH',
        'Stored file integrity check failed',
        409,
      );
  }

  async get(key: string) {
    const response = await this.call(
      `object/authenticated/${this.env.EVIDENCE_BUCKET}/${key}`,
    );
    if (!response.ok || !response.body) throw this.failure();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_EVIDENCE_FILE_BYTES) {
          await reader.cancel();
          throw this.failure();
        }
        chunks.push(value);
      }
    } catch {
      throw this.failure();
    }
    return Buffer.concat(chunks);
  }
}
