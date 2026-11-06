import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseEnvironment } from '../../src/common/config/environment.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';

describe('M01 operator CLI (real PostgreSQL, MOCK user UUID)', () => {
  const merchantId = randomUUID();
  const userId = randomUUID();
  let prisma: PrismaService;
  afterAll(async () => {
    if (prisma) {
      await prisma.merchantEvent.deleteMany({ where: { merchantId } });
      await prisma.merchantMember.deleteMany({ where: { merchantId } });
      await prisma.merchant.deleteMany({ where: { id: merchantId } });
      await prisma.$disconnect();
    }
  });

  it('provisions membership idempotently without resetting existing policy', async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('TEST_DATABASE_URL is required');
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    prisma = new PrismaService(
      parseEnvironment({ DATABASE_URL: process.env.TEST_DATABASE_URL }),
    );
    const invoke = () =>
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              '../../../../node_modules/tsx/dist/cli.mjs',
              import.meta.url,
            ),
          ),
          '--tsconfig',
          'apps/api/tsconfig.json',
          'apps/api/src/commands/setup-merchant.ts',
          '--user-id',
          userId,
          '--display-name',
          'MOCK CLI Merchant',
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            DATABASE_URL: process.env.TEST_DATABASE_URL,
            MERCHANT_ID: merchantId,
          },
          encoding: 'utf8',
          timeout: 15000,
        },
      );
    expect(invoke()).toContain('membership provisioned');
    await prisma.merchant.update({
      where: { id: merchantId },
      data: { allowInvestigations: true },
    });
    expect(invoke()).toContain('membership provisioned');
    expect(
      await prisma.merchantMember.count({
        where: { merchantId, authUserId: userId, role: 'ADMIN' },
      }),
    ).toBe(1);
    expect(
      (await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } }))
        .allowInvestigations,
    ).toBe(true);
    expect(
      await prisma.merchantEvent.count({
        where: { merchantId, action: 'MEMBER_PROVISIONED_BY_OPERATOR' },
      }),
    ).toBe(2);
  }, 30000);
});
