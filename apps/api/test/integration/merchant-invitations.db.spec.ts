import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { MerchantInvitationsService } from '../../src/modules/merchants/merchant-invitations.service.js';
import {
  InvitationMailer,
  InvitationMailError,
} from '../../src/modules/merchants/invitation-mailer.js';
import { AuditService } from '../../src/modules/monitoring/audit.service.js';
import { ENVIRONMENT } from '../../src/common/config/environment.js';
import { createMockAuth } from '../fixtures/auth.js';

describe('M01 invitations: PostgreSQL, signed MOCK Auth, MOCK email', () => {
  const merchantId = randomUUID(),
    admin = randomUUID(),
    buyer = randomUUID(),
    viewer = randomUUID(),
    outsider = randomUUID();
  let issuer: Awaited<ReturnType<typeof createMockAuth>>,
    ctx: Awaited<ReturnType<typeof createApp>>,
    db: PrismaService,
    service: MerchantInvitationsService,
    mailer: InvitationMailer;
  const tokens = new Map<string, string>();
  const actor = { merchantId, userId: admin, role: 'ADMIN' as const };
  const profile = (id: string, email: string, confirmed = true) =>
    issuer.profiles.set(id, {
      email,
      email_confirmed_at: confirmed ? new Date().toISOString() : null,
    });
  const http = () => request(ctx.app.getHttpServer());
  const invite = async (email: string, role: 'ADMIN' | 'VIEWER' = 'VIEWER') => {
    const res = await http()
      .post('/api/merchants/me/invitations')
      .set('Authorization', `Bearer ${tokens.get(admin)}`)
      .set('X-Merchant-Id', merchantId)
      .send({ email, role });
    expect(res.status, res.text).toBe(201);
    return res.body as { id: string; deliveryStatus: string; shareUrl: string };
  };
  const accept = (id: string, user = buyer, body = {}) =>
    http()
      .post(`/api/merchant-invitations/${id}/accept`)
      .set('Authorization', `Bearer ${tokens.get(user)}`)
      .send(body);
  beforeAll(async () => {
    issuer = await createMockAuth();
    ctx = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        SUPABASE_URL: issuer.origin,
        SUPABASE_SECRET_KEY: `sb_secret_${'x'.repeat(32)}`,
        INVITATION_EMAIL_WORKER_ENABLED: 'false',
      },
      false,
    );
    await ctx.app.init();
    db = ctx.app.get(PrismaService);
    service = ctx.app.get(MerchantInvitationsService);
    mailer = ctx.app.get(InvitationMailer);
    await db.merchant.create({
      data: {
        id: merchantId,
        displayName: 'Invitation test',
        members: {
          create: [
            { authUserId: admin, role: 'ADMIN' },
            { authUserId: viewer, role: 'VIEWER' },
          ],
        },
      },
    });
    for (const [id, email] of [
      [admin, 'admin@example.test'],
      [buyer, 'buyer@example.test'],
      [viewer, 'viewer@example.test'],
      [outsider, 'outsider@example.test'],
    ]) {
      profile(id!, email!);
      tokens.set(
        id!,
        await issuer.token(id!, {
          user_metadata: { email: 'buyer@example.test' },
        }),
      );
    }
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (db) {
      await db.merchantInvitation.deleteMany({ where: { merchantId } });
      await db.merchantEvent.deleteMany({ where: { merchantId } });
      await db.merchantMember.deleteMany({ where: { merchantId } });
      await db.merchant.delete({ where: { id: merchantId } });
    }
    await ctx?.app.close();
    await issuer?.close();
  });
  it('requires authentication and admin for sender routes', async () => {
    await http().get('/api/merchant-invitations').expect(401);
    for (const path of ['/api/merchants/me/invitations'])
      await http()
        .get(path)
        .set('Authorization', `Bearer ${tokens.get(viewer)}`)
        .set('X-Merchant-Id', merchantId)
        .expect(403);
    await http()
      .post('/api/merchants/me/invitations')
      .set('Authorization', `Bearer ${tokens.get(viewer)}`)
      .set('X-Merchant-Id', merchantId)
      .send({ email: 'x@example.test' })
      .expect(403);
  });
  it('normalizes email, defaults to viewer and provides honest delivery + link', async () => {
    const res = await http()
      .post('/api/merchants/me/invitations')
      .set('Authorization', `Bearer ${tokens.get(admin)}`)
      .set('X-Merchant-Id', merchantId)
      .send({ email: '  BUYER@example.test  ' })
      .expect(201);
    expect(res.body).toMatchObject({
      email: 'buyer@example.test',
      role: 'VIEWER',
      deliveryStatus: 'NOT_CONFIGURED',
      status: 'PENDING',
    });
    expect(res.body.shareUrl).toBe(
      `http://localhost:3000/?teamInvitation=${res.body.id}`,
    );
  });
  it('rejects duplicate, self invitation and injected authority', async () => {
    for (const [body, status] of [
      [{ email: 'buyer@example.test' }, 409],
      [{ email: 'admin@example.test' }, 409],
      [{ email: 'x@example.test', authUserId: outsider }, 400],
      [{ email: 'x@example.test', role: 'OWNER' }, 400],
    ] as const)
      await http()
        .post('/api/merchants/me/invitations')
        .set('Authorization', `Bearer ${tokens.get(admin)}`)
        .set('X-Merchant-Id', merchantId)
        .send(body)
        .expect(status);
  });
  it('allows recipient without membership to list; ignores spoofed user metadata', async () => {
    const res = await http()
      .get('/api/merchant-invitations')
      .set('Authorization', `Bearer ${tokens.get(buyer)}`)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    const other = await http()
      .get('/api/merchant-invitations')
      .set('Authorization', `Bearer ${tokens.get(outsider)}`)
      .expect(200);
    expect(other.body.items).toEqual([]);
    await accept(res.body.items[0].id, outsider).expect(404);
  });
  it('uses current confirmed email; changed email cannot accept an old invitation', async () => {
    const row = await db.merchantInvitation.findFirstOrThrow({
      where: { merchantId, email: 'buyer@example.test' },
    });
    profile(buyer, 'buyer@example.test', false);
    await accept(row.id).expect(403);
    profile(buyer, 'new@example.test');
    await accept(row.id).expect(404);
    profile(buyer, 'buyer@example.test');
    await accept(row.id, buyer, { role: 'ADMIN' }).expect(400);
  });
  it('concurrent acceptance creates exactly one viewer membership and audit event', async () => {
    const row = await db.merchantInvitation.findFirstOrThrow({
      where: { merchantId, email: 'buyer@example.test' },
    });
    const results = await Promise.all([accept(row.id), accept(row.id)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0]!.body.role).toBe('VIEWER');
    expect(
      await db.merchantMember.count({
        where: { merchantId, authUserId: buyer },
      }),
    ).toBe(1);
    expect(
      await db.merchantEvent.count({
        where: { merchantId, action: 'TEAM_INVITATION_ACCEPTED' },
      }),
    ).toBe(1);
  });
  it('does not elevate an existing viewer through an admin invitation', async () => {
    const row = await invite('viewer@example.test', 'ADMIN');
    const res = await accept(row.id, viewer).expect(201);
    expect(res.body.role).toBe('VIEWER');
  });
  it('revoked invitations cannot be accepted and other teams cannot revoke them', async () => {
    const row = await invite('outsider@example.test');
    await http()
      .post(`/api/merchants/me/invitations/${row.id}/revoke`)
      .set('Authorization', `Bearer ${tokens.get(outsider)}`)
      .set('X-Merchant-Id', merchantId)
      .expect(403);
    await service.manage(actor, row.id, 'revoke');
    await accept(row.id, outsider).expect(409);
    expect(
      await db.merchantMember.count({
        where: { merchantId, authUserId: outsider },
      }),
    ).toBe(0);
  });
  it('expired invitations are unusable and can be replaced', async () => {
    const row = await invite('expiry@example.test');
    await db.merchantInvitation.update({
      where: { id: row.id },
      data: { expiresAt: new Date(0) },
    });
    profile(outsider, 'expiry@example.test');
    await accept(row.id, outsider).expect(410);
    const next = await invite('expiry@example.test');
    expect(next.id).not.toBe(row.id);
    profile(outsider, 'outsider@example.test');
  });
  it('recipient can decline but cannot accept declined invitations', async () => {
    const row = await invite('outsider@example.test');
    await http()
      .post(`/api/merchant-invitations/${row.id}/decline`)
      .set('Authorization', `Bearer ${tokens.get(outsider)}`)
      .expect(201);
    await accept(row.id, outsider).expect(409);
  });
  it('inactive inviting admin cannot grant access', async () => {
    const row = await invite('inactive@example.test');
    profile(outsider, 'inactive@example.test');
    await db.merchantMember.updateMany({
      where: { merchantId, authUserId: admin },
      data: { active: false },
    });
    await accept(row.id, outsider).expect(403);
    await db.merchantMember.updateMany({
      where: { merchantId, authUserId: admin },
      data: { active: true },
    });
    profile(outsider, 'outsider@example.test');
  });
  it('audit failure rolls back invitation creation', async () => {
    const spy = vi
      .spyOn(ctx.app.get(AuditService), 'append')
      .mockRejectedValueOnce(new Error('MOCK audit unavailable'));
    await expect(
      service.create(
        actor,
        { userId: admin, email: 'admin@example.test' },
        { email: 'rollback@example.test', role: 'VIEWER' },
      ),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(
      await db.merchantInvitation.count({
        where: { merchantId, email: 'rollback@example.test' },
      }),
    ).toBe(0);
  });
  it('claims email once and records provider acceptance', async () => {
    vi.spyOn(mailer, 'configured', 'get').mockReturnValue(true);
    const send = vi.spyOn(mailer, 'send').mockResolvedValue();
    const row = await invite('delivery@example.test');
    await Promise.all([service.deliverNext(), service.deliverNext()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].email).toBe('delivery@example.test');
    expect(
      await db.merchantInvitation.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ deliveryStatus: 'SENT', emailAttempts: 1 });
    vi.restoreAllMocks();
  });
  it('does not retry an uncertain SMTP outcome automatically', async () => {
    vi.spyOn(mailer, 'configured', 'get').mockReturnValue(true);
    vi.spyOn(mailer, 'retrySafe', 'get').mockReturnValue(false);
    const send = vi
      .spyOn(mailer, 'send')
      .mockRejectedValue(new InvitationMailError('EMAIL_SMTP_UNCERTAIN', true));
    const row = await invite('uncertain@example.test');
    await service.deliverNext();
    await service.deliverNext();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db.merchantInvitation.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ deliveryStatus: 'UNCERTAIN' });
    vi.restoreAllMocks();
  });
  it('never sends a revoked queued invitation', async () => {
    vi.spyOn(mailer, 'configured', 'get').mockReturnValue(true);
    const send = vi.spyOn(mailer, 'send').mockResolvedValue();
    const row = await invite('revoked-mail@example.test');
    await service.manage(actor, row.id, 'revoke');
    await service.deliverNext();
    expect(send).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('enables RLS and keeps recipient email out of audit metadata', async () => {
    const rows = await db.$queryRaw<
      Array<{ relrowsecurity: boolean }>
    >`SELECT relrowsecurity FROM pg_class WHERE oid='merchant_invitations'::regclass`;
    expect(rows[0]!.relrowsecurity).toBe(true);
    const audit = await db.auditEvent.findMany({
      where: { merchantId, action: 'TEAM_INVITATION_EVENT' },
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain('@example.test');
  });
  it('reactivates an inactive membership with the invited role', async () => {
    await db.merchantMember.create({
      data: { merchantId, authUserId: outsider, role: 'VIEWER', active: false },
    });
    const row = await invite('outsider@example.test', 'ADMIN');
    const result = await accept(row.id, outsider).expect(201);
    expect(result.body.role).toBe('ADMIN');
    expect(
      await db.merchantMember.count({
        where: { merchantId, authUserId: outsider, active: true },
      }),
    ).toBe(1);
  });
  it('two worker instances claim one delivery and retry the same provider key after backoff', async () => {
    vi.spyOn(mailer, 'configured', 'get').mockReturnValue(true);
    vi.spyOn(mailer, 'retrySafe', 'get').mockReturnValue(true);
    const send = vi
      .spyOn(mailer, 'send')
      .mockRejectedValueOnce(new InvitationMailError('EMAIL_HTTP_429'))
      .mockResolvedValue();
    const row = await invite('retry@example.test');
    const other = new MerchantInvitationsService(
      db,
      ctx.app.get(ENVIRONMENT),
      mailer,
      ctx.app.get(AuditService),
    );
    await Promise.all([service.deliverNext(), other.deliverNext()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db.merchantInvitation.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ deliveryStatus: 'PENDING', emailAttempts: 1 });
    await service.deliverNext();
    expect(send).toHaveBeenCalledTimes(1);
    await db.merchantInvitation.update({
      where: { id: row.id },
      data: { nextEmailAttemptAt: new Date(0) },
    });
    await service.deliverNext();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].version).toBe(send.mock.calls[1]![0].version);
    expect(
      await db.merchantInvitation.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ deliveryStatus: 'SENT', emailAttempts: 2 });
    vi.restoreAllMocks();
  });
  it('does not repeat an ambiguous delivery outside the provider idempotency window', async () => {
    vi.spyOn(mailer, 'configured', 'get').mockReturnValue(true);
    vi.spyOn(mailer, 'retrySafe', 'get').mockReturnValue(true);
    const send = vi.spyOn(mailer, 'send').mockResolvedValue();
    const row = await invite('old-lease@example.test');
    await db.merchantInvitation.update({
      where: { id: row.id },
      data: {
        deliveryStatus: 'PROCESSING',
        emailAttempts: 1,
        emailLeaseUntil: new Date(0),
        updatedAt: new Date(Date.now() - 25 * 3600000),
      },
    });
    await service.deliverNext();
    expect(send).not.toHaveBeenCalled();
    expect(
      await db.merchantInvitation.findUnique({ where: { id: row.id } }),
    ).toMatchObject({
      deliveryStatus: 'UNCERTAIN',
      emailErrorCode: 'EMAIL_IDEMPOTENCY_WINDOW_EXPIRED',
    });
    vi.restoreAllMocks();
  });
  it('serializes accept against revoke without granting a revoked invitation', async () => {
    const recipient = randomUUID();
    profile(recipient, 'race@example.test');
    const row = await invite('race@example.test');
    const results = await Promise.allSettled([
      service.respond(
        { userId: recipient, email: 'race@example.test' },
        row.id,
        'accept',
      ),
      service.manage(actor, row.id, 'revoke'),
    ]);
    const stored = await db.merchantInvitation.findUniqueOrThrow({
      where: { id: row.id },
    });
    const count = await db.merchantMember.count({
      where: { merchantId, authUserId: recipient, active: true },
    });
    expect(
      stored.status === 'ACCEPTED'
        ? count === 1
        : stored.status === 'REVOKED' && count === 0,
    ).toBe(true);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
  });
});
