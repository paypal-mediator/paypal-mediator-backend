import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OdooAdapter } from '../../src/modules/integrations/adapters/odoo.adapter.js';
import { IntegrationsService } from '../../src/modules/integrations/integrations.service.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { AuditService } from '../../src/modules/monitoring/audit.service.js';
import { JobsService } from '../../src/modules/jobs/jobs.service.js';
import { parseEnvironment } from '../../src/common/config/environment.js';
import { decryptErpSecret } from '../../src/common/crypto/secret-box.js';
const credentials = {
  apiKey: 'MOCK-secret',
  baseUrl: 'https://demo.odoo.com',
  database: 'demo',
};
afterEach(() => vi.unstubAllGlobals());
describe('Odoo connections (MOCK external API)', () => {
  it('reads payment memo from JSON-2 and preserves it as the normalized reference', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json([
          {
            id: 1,
            name: 'PAY/1',
            partner_id: [2, 'Demo'],
            date: '2026-11-12',
            amount: 12,
            currency_id: [1, 'MXN'],
            memo: 'ORDER-1',
            write_date: '2026-11-12 00:00:00',
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await new OdooAdapter().pullPayments(credentials);
    expect(result.records[0]).toMatchObject({
      reference: 'ORDER-1',
      amount: '12',
    });
    const fields = JSON.parse(fetchMock.mock.calls[0]![1].body).fields;
    expect(fields).toContain('memo');
    expect(fields).not.toContain('ref');
  });
  it('uses uid from the real context_get response shape and rejects invalid identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ uid: 2 }))
        .mockResolvedValueOnce(Response.json({ id: 2 })),
    );
    const adapter = new OdooAdapter();
    expect((await adapter.verifyConnection(credentials)).externalTenantId).toBe(
      'odoo_demo_2',
    );
    await expect(adapter.verifyConnection(credentials)).rejects.toThrow(
      'invalid user',
    );
  });
  it('persists verified identity and encrypted database credentials only after verification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ uid: 2 })),
    );
    const environment = parseEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://mock:mock@localhost:1/mock',
      MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    });
    const create = vi.fn().mockResolvedValue({
      id: 'mock-connection',
      merchantId: 'team-a',
      provider: 'odoo',
      status: 'connected',
    });
    const service = new IntegrationsService(
      environment,
      { erpConnection: { create } } as unknown as PrismaService,
      { append: vi.fn() } as unknown as AuditService,
      {} as JobsService,
    );
    expect(service.getCatalog().items.map((item) => item.provider)).toEqual([
      'odoo',
    ]);
    await service.connectWithKey(
      'team-a',
      'odoo',
      credentials.apiKey,
      credentials.baseUrl,
      credentials.database,
    );
    const data = create.mock.calls[0]![0].data;
    expect(data.merchantId).toBe('team-a');
    expect(data.externalTenantId).toBe('odoo_demo_2');
    expect(
      await decryptErpSecret(data.secret.create.encryptedPayload, environment),
    ).toEqual(credentials);
    create.mockClear();
    await expect(
      service.connectWithKey('team-a', 'bind', 'mock'),
    ).rejects.toMatchObject({ code: 'ERP_PROVIDER_UNAVAILABLE' });
    await expect(
      service.connectWithKey(
        'team-a',
        'odoo',
        'mock',
        'https://127.0.0.1',
        'demo',
      ),
    ).rejects.toMatchObject({ code: 'ODOO_URL_INVALID' });
    await expect(
      service.connectWithKey('team-a', 'odoo', 'mock', credentials.baseUrl),
    ).rejects.toMatchObject({ code: 'ODOO_CONFIGURATION_REQUIRED' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('MOCK secret error', { status: 401 })),
    );
    await expect(
      service.connectWithKey(
        'team-a',
        'odoo',
        'mock',
        credentials.baseUrl,
        'demo',
      ),
    ).rejects.toMatchObject({ code: 'ERP_CONNECTION_VERIFICATION_FAILED' });
    expect(create).not.toHaveBeenCalled();
  });
});
