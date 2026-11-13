import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CreateMerchantInvitationSchema,
  InvitationActionSchema,
  type CreateMerchantInvitation,
} from '@resolve-ai/contracts';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  type MerchantRequest,
} from './auth/merchant-access.guard.js';
import { SupabaseAuthService } from './auth/supabase-auth.service.js';
import { MerchantInvitationsService } from './merchant-invitations.service.js';

@Controller('merchants/me/invitations')
@ApiBearerAuth('supabase')
@ApiTags('team invitations')
@UseGuards(MerchantAccessGuard)
@MerchantAdminOnly()
export class TeamInvitationsController {
  constructor(
    @Inject(MerchantInvitationsService)
    private readonly invitations: MerchantInvitationsService,
    @Inject(SupabaseAuthService) private readonly auth: SupabaseAuthService,
  ) {}
  @Get() list(@Req() request: MerchantRequest) {
    return this.invitations.listAdmin(request.merchantActor);
  }
  @Post() async create(
    @Req() request: MerchantRequest,
    @Body(new ZodValidationPipe(CreateMerchantInvitationSchema))
    input: CreateMerchantInvitation,
  ) {
    return this.invitations.create(
      request.merchantActor,
      await this.auth.identity(request.headers.authorization),
      input,
    );
  }
  @Post(':id/revoke') revoke(
    @Req() request: MerchantRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(InvitationActionSchema)) _input: unknown,
  ) {
    void _input;
    return this.invitations.manage(request.merchantActor, id, 'revoke');
  }
  @Post(':id/resend') resend(
    @Req() request: MerchantRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(InvitationActionSchema)) _input: unknown,
  ) {
    void _input;
    return this.invitations.manage(request.merchantActor, id, 'resend');
  }
}

// Deliberately account-scoped: invitees need no existing team membership.
@Controller('merchant-invitations')
@ApiBearerAuth('supabase')
@ApiTags('team invitations')
export class AccountInvitationsController {
  constructor(
    @Inject(MerchantInvitationsService)
    private readonly invitations: MerchantInvitationsService,
    @Inject(SupabaseAuthService) private readonly auth: SupabaseAuthService,
  ) {}
  @Get() async list(@Req() request: Request) {
    return this.invitations.list(
      await this.auth.identity(request.headers.authorization),
    );
  }
  @Get(':id') async detail(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.invitations.detail(
      await this.auth.identity(request.headers.authorization),
      id,
    );
  }
  @Post(':id/accept') async accept(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(InvitationActionSchema)) _input: unknown,
  ) {
    void _input;
    return this.invitations.respond(
      await this.auth.identity(request.headers.authorization),
      id,
      'accept',
    );
  }
  @Post(':id/decline') async decline(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(InvitationActionSchema)) _input: unknown,
  ) {
    void _input;
    return this.invitations.respond(
      await this.auth.identity(request.headers.authorization),
      id,
      'decline',
    );
  }
}
