import { Inject, Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';

export class InvitationMailError extends Error {
  constructor(
    public readonly code: string,
    public readonly uncertain = false,
  ) {
    super(code);
  }
}

@Injectable()
export class InvitationMailer {
  constructor(@Inject(ENVIRONMENT) private readonly env: Environment) {}
  get configured() {
    return Boolean(
      this.env.INVITATION_EMAIL_FROM &&
      ((this.env.INVITATION_EMAIL_PROVIDER === 'resend' &&
        this.env.RESEND_API_KEY) ||
        (this.env.INVITATION_EMAIL_PROVIDER === 'smtp' &&
          this.env.SMTP_HOST &&
          this.env.SMTP_USERNAME &&
          this.env.SMTP_PASSWORD)),
    );
  }
  get retrySafe() {
    return this.env.INVITATION_EMAIL_PROVIDER === 'resend';
  }
  async send(input: {
    id: string;
    version: number;
    email: string;
    team: string;
    role: string;
    url: string;
  }) {
    if (!this.configured) throw new InvitationMailError('EMAIL_NOT_CONFIGURED');
    const text = `Te invitaron al equipo ${input.team} con el rol ${input.role}.\n\nAcepta con tu cuenta de correo verificada:\n${input.url}\n\nLa invitación vence en 7 días. Si no esperabas esta invitación, puedes ignorarla.`;
    if (this.env.INVITATION_EMAIL_PROVIDER === 'resend') {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: {
            authorization: `Bearer ${this.env.RESEND_API_KEY}`,
            'content-type': 'application/json',
            'Idempotency-Key': `team-invitation/${input.id}/${input.version}`,
          },
          body: JSON.stringify({
            from: this.env.INVITATION_EMAIL_FROM,
            to: [input.email],
            subject: 'Invitación a un equipo · Resolve AI',
            text,
          }),
        });
        if (!response.ok)
          throw new InvitationMailError(`EMAIL_HTTP_${response.status}`);
        return;
      } catch (error) {
        if (error instanceof InvitationMailError) throw error;
        throw new InvitationMailError('EMAIL_NETWORK_ERROR');
      }
    }
    const transport = nodemailer.createTransport({
      host: this.env.SMTP_HOST,
      port: this.env.SMTP_PORT,
      secure: this.env.SMTP_SECURE,
      requireTLS: !this.env.SMTP_SECURE,
      auth: { user: this.env.SMTP_USERNAME!, pass: this.env.SMTP_PASSWORD! },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({
        from: this.env.INVITATION_EMAIL_FROM,
        to: input.email,
        subject: 'Invitación a un equipo · Resolve AI',
        text,
      });
      if (!result.accepted.length)
        throw new InvitationMailError('EMAIL_REJECTED');
    } catch (error) {
      if (error instanceof InvitationMailError) throw error;
      // A transport interruption may happen after SMTP accepted the message.
      throw new InvitationMailError('EMAIL_SMTP_UNCERTAIN', true);
    } finally {
      transport.close();
    }
  }
}
