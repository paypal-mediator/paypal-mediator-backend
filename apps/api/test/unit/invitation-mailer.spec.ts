import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentSchema } from '../../src/common/config/environment.js';
import { InvitationMailer } from '../../src/modules/merchants/invitation-mailer.js';

const input = {
  id: '00000000-0000-4000-8000-000000000001',
  version: 2,
  email: 'invited@example.test',
  team: '<A team>',
  role: 'VIEWER',
  url: 'https://frontend.test/?teamInvitation=00000000-0000-4000-8000-000000000001',
};
const environment = (overrides: Record<string, string> = {}) =>
  EnvironmentSchema.parse({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    ...overrides,
  });
describe('Invitation email provider (MOCK HTTP only)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('does not report email configured without a provider, secret and sender', () => {
    expect(new InvitationMailer(environment()).configured).toBe(false);
    expect(
      new InvitationMailer(
        environment({
          INVITATION_EMAIL_PROVIDER: 'resend',
          RESEND_API_KEY: 'MOCK',
        }),
      ).configured,
    ).toBe(false);
  });
  it('uses the fixed provider endpoint, idempotency key and plain text with correct recipient/link', async () => {
    const send = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', send);
    const mailer = new InvitationMailer(
      environment({
        INVITATION_EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'MOCK_SECRET',
        INVITATION_EMAIL_FROM: 'team@example.test',
      }),
    );
    await mailer.send(input);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, options] = send.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(options.headers['Idempotency-Key']).toBe(
      `team-invitation/${input.id}/2`,
    );
    const body = JSON.parse(options.body);
    expect(body.to).toEqual([input.email]);
    expect(body.text).toContain(input.url);
    expect(body.html).toBeUndefined();
  });
  it('sanitizes rejected provider responses and network failures', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('sensitive provider payload', { status: 429 }),
      )
      .mockRejectedValueOnce(new Error('sensitive network payload'));
    vi.stubGlobal('fetch', send);
    const mailer = new InvitationMailer(
      environment({
        INVITATION_EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'MOCK_SECRET',
        INVITATION_EMAIL_FROM: 'team@example.test',
      }),
    );
    await expect(mailer.send(input)).rejects.toMatchObject({
      message: 'EMAIL_HTTP_429',
    });
    await expect(mailer.send(input)).rejects.toMatchObject({
      message: 'EMAIL_NETWORK_ERROR',
    });
  });
});
