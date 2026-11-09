import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config } from 'dotenv';
import { z } from 'zod';
import { MerchantRoleSchema } from '@resolve-ai/contracts';
import { parseEnvironment } from '../common/config/environment.js';
import { PrismaService } from '../common/database/prisma.service.js';

config({
  path: fileURLToPath(new URL('../../../../.env', import.meta.url)),
  quiet: true,
});
let prisma: PrismaService | undefined;
try {
  const environment = parseEnvironment(process.env);
  if (!environment.MERCHANT_ID)
    throw new Error('Missing merchant configuration');
  const merchantId = environment.MERCHANT_ID;
  const { values } = parseArgs({
    options: {
      'user-id': { type: 'string' },
      'display-name': { type: 'string', default: 'ResolveAI Sandbox Merchant' },
      role: { type: 'string', default: 'ADMIN' },
    },
  });
  const userId = z.uuid().parse(values['user-id']);
  const displayName = z
    .string()
    .trim()
    .min(1)
    .max(120)
    .parse(values['display-name']);
  const role = MerchantRoleSchema.parse(values.role);
  prisma = new PrismaService(environment);
  await prisma.$transaction(async (tx) => {
    const existingMember = await tx.merchantMember.findFirst({
      where: { authUserId: userId },
    });
    if (existingMember && existingMember.merchantId !== merchantId)
      throw new Error('Conflicting membership');
    await tx.merchant.upsert({
      where: { id: merchantId },
      create: { id: merchantId, displayName },
      update: {},
    });
    if (existingMember) {
      await tx.merchantMember.update({
        where: { id: existingMember.id },
        data: { merchantId, role, active: true },
      });
    } else {
      await tx.merchantMember.create({
        data: { merchantId, authUserId: userId, role },
      });
    }
    await tx.merchantEvent.create({
      data: {
        merchantId,
        actorUserId: userId,
        action: 'MEMBER_PROVISIONED_BY_OPERATOR',
        details: { role, source: 'SERVER_CLI' },
      },
    });
  });
  console.log(
    'Sandbox merchant and membership provisioned. No PayPal connection has been verified.',
  );
} catch {
  console.error(
    'Merchant setup failed. Check configuration, migration, --user-id UUID and --role ADMIN|VIEWER.',
  );
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}
