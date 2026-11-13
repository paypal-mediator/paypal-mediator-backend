import 'reflect-metadata';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { OdooAdapter } from '../../src/modules/integrations/adapters/odoo.adapter.js';

const credentials = {
  baseUrl: 'https://demo.odoo.com',
  database: 'demo',
  apiKey: 'MOCK',
};
afterEach(() => vi.unstubAllGlobals());
describe('Odoo connector boundaries (MOCK provider)', () => {
  it('paginates equal write_date values by ID instead of skipping the remaining records', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `INV/${index}`,
      partner_id: false,
      invoice_date: '2026-11-05',
      amount_total: 1,
      currency_id: [1, 'USD'],
      payment_reference: '',
      invoice_payment_term_id: false,
      write_date: '2026-11-05 00:00:00',
    }));
    const fetcher = vi.fn().mockImplementation(async () => Response.json(rows));
    vi.stubGlobal('fetch', fetcher);
    const adapter = new OdooAdapter();
    const first = await adapter.pullInvoices(credentials);
    expect(first.nextCursor).toMatch(/^v1:/);
    await adapter.pullInvoices(credentials, first.nextCursor);
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body.domain).toContainEqual([
      'write_date',
      '=',
      '2026-11-05 00:00:00',
    ]);
    expect(body.domain).toContainEqual(['id', '>', 100]);
    expect(body.order).toBe('write_date asc, id asc');
  });
  it('rejects a document returned for a parent outside the confirmed record graph', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json([
          {
            id: 1,
            res_model: 'account.move',
            res_id: 99,
            name: 'foreign.pdf',
            mimetype: 'application/pdf',
            file_size: 20,
            write_date: '2026-11-05 00:00:00',
          },
        ]),
      ),
    );
    await expect(
      new OdooAdapter().readLinkedDocuments(
        credentials,
        [{ recordType: 'invoice', externalId: '11' }],
        'MOCK',
      ),
    ).rejects.toThrow('ODOO_ATTACHMENT_PARENT_MISMATCH');
  });
  it('sanitizes provider exception bodies rather than recording debug data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          error: {
            message: 'MOCK-SECRET',
            data: { debug: 'MOCK-PRIVATE-TRACE' },
          },
        }),
      ),
    );
    await expect(
      new OdooAdapter().verifyConnection(credentials),
    ).rejects.toThrow('ODOO_PROVIDER_ERROR');
  });
  it('bounds streamed provider responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1))),
    );
    await expect(
      new OdooAdapter().verifyConnection(credentials),
    ).rejects.toThrow('ODOO_RESPONSE_TOO_LARGE');
  });
});
