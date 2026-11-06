import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnvironment } from '../../src/common/config/environment.js';
import { EvidenceStorage } from '../../src/modules/evidence/evidence-storage.js';

const bytes = Buffer.from('%PDF-1.7\nDEMO / MOCK original\n%%EOF');
const key = 'mock-merchant/mock-transaction/mock-sha256';
function storage(configured = true) {
  return new EvidenceStorage(
    parseEnvironment({
      DATABASE_URL: 'postgresql://mock:mock@localhost/mock',
      ...(configured
        ? {
            SUPABASE_URL: 'https://mock.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'MOCK-SECRET',
          }
        : {}),
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());
describe('M04 Storage adapter (explicit MOCK fetch)', () => {
  it('uses modern backend keys only in apikey, never as a bearer JWT', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ public: false }));
    vi.stubGlobal('fetch', fetcher);
    const adapter = new EvidenceStorage(
      parseEnvironment({
        DATABASE_URL: 'postgresql://mock:mock@localhost/mock',
        SUPABASE_URL: 'https://mock.supabase.co',
        SUPABASE_SECRET_KEY: 'sb_secret_MOCK_ONLY_NOT_A_REAL_KEY',
        SUPABASE_SERVICE_ROLE_KEY: 'MOCK_LEGACY',
      }),
    );
    await adapter.ensurePrivate();
    const headers = fetcher.mock.calls[0]![1].headers;
    expect(headers.apikey).toBe('sb_secret_MOCK_ONLY_NOT_A_REAL_KEY');
    expect(headers.Authorization).toBeUndefined();
  });
  it.each([400, 404])(
    'provisions a missing private bucket with MIME and size restrictions (%s)',
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { statusCode: '404', error: 'Bucket not found' },
            { status },
          ),
        )
        .mockResolvedValueOnce(Response.json({ name: 'private-evidence' }))
        .mockResolvedValueOnce(Response.json({ public: false }));
      vi.stubGlobal('fetch', fetcher);
      await expect(storage().setupBucket()).resolves.toEqual({
        bucket: 'private-evidence',
        created: true,
        private: true,
      });
      expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({
        public: false,
        file_size_limit: 524288,
        allowed_mime_types: ['application/pdf', 'image/png', 'image/jpeg'],
      });
    },
  );
  it('never changes an existing public bucket while provisioning', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () => Response.json({ public: true }));
    vi.stubGlobal('fetch', fetcher);
    await expect(storage().setupBucket()).rejects.toThrow('private');
    expect(fetcher.mock.calls.every((call) => call[1].method !== 'POST')).toBe(
      true,
    );
  });
  it.each([400, 409])(
    'recovers an already uploaded identical original (%s)',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(Response.json({ public: false }))
          .mockResolvedValueOnce(
            Response.json({ error: 'Duplicate' }, { status }),
          )
          .mockResolvedValueOnce(new Response(bytes)),
      );
      await expect(
        storage().put(key, bytes, 'application/pdf'),
      ).resolves.toBeUndefined();
    },
  );
  it('writes without overwrite, checks private bucket and reads back the original', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ public: false }))
      .mockResolvedValueOnce(Response.json({ Key: key }))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    await storage().put(key, bytes, 'application/pdf');
    expect(fetcher.mock.calls[1]).toEqual([
      `https://mock.supabase.co/storage/v1/object/private-evidence/${key}`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({ 'x-upsert': 'false' }),
      }),
    ]);
    expect(fetcher.mock.calls[2]![0]).toContain('/object/authenticated/');
  });
  it.each([400, 409])(
    'accepts a duplicate only after verifying bytes (%s)',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(Response.json({ public: false }))
          .mockResolvedValueOnce(
            Response.json({ error: 'Duplicate' }, { status }),
          )
          .mockResolvedValueOnce(new Response('MOCK tampered')),
      );
      await expect(
        storage().put(key, bytes, 'application/pdf'),
      ).rejects.toThrow('integrity');
    },
  );
  it('refuses a public bucket before uploading', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ public: true }));
    vi.stubGlobal('fetch', fetcher);
    await expect(storage().put(key, bytes, 'application/pdf')).rejects.toThrow(
      'private',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('fails closed without credentials', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      storage(false).put(key, bytes, 'application/pdf'),
    ).rejects.toThrow('not configured');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sanitizes transport failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('MOCK-SECRET')));
    await expect(storage().ensurePrivate()).rejects.toThrow(
      /^Evidence storage operation failed$/,
    );
  });
  it('never treats a permission failure as a duplicate', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ public: false }))
        .mockResolvedValueOnce(
          Response.json({ error: 'AccessDenied' }, { status: 403 }),
        ),
    );
    await expect(storage().put(key, bytes, 'application/pdf')).rejects.toThrow(
      'operation failed',
    );
  });
  it('bounds downloaded bytes even without Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(new Uint8Array(512 * 1024 + 1))),
    );
    await expect(storage().get(key)).rejects.toThrow('operation failed');
  });
});
