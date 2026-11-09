import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { MerchantRole } from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../../common/config/environment.js';
import { PrismaService } from '../../../common/database/prisma.service.js';
import { ApiException } from '../../../common/http/api.exception.js';
import { SupabaseAuthService } from './supabase-auth.service.js';

export interface MerchantActor {
  userId: string;
  merchantId: string;
  role: MerchantRole;
}
export type MerchantRequest = Request & { merchantActor: MerchantActor };
const ADMIN_ONLY = 'merchants:admin-only';
export const MerchantAdminOnly = () => SetMetadata(ADMIN_ONLY, true);

@Injectable()
export class MerchantAccessGuard implements CanActivate {
  constructor(
    @Inject(SupabaseAuthService) private readonly auth: SupabaseAuthService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MerchantRequest>();
    const userId = await this.auth.authenticate(request.headers.authorization);

    let merchantId: string;
    let role: MerchantRole;

    if (this.environment.MERCHANT_ID) {
      // Single-tenant legacy: only the configured merchant is accessible.
      const member = await this.prisma.merchantMember.findFirst({
        where: {
          authUserId: userId,
          active: true,
          merchantId: this.environment.MERCHANT_ID,
        },
      });
      if (!member) {
        throw new ApiException(
          'MERCHANT_ACCESS_DENIED',
          'Access to this merchant is not authorized',
          403,
        );
      }
      merchantId = this.environment.MERCHANT_ID;
      role = member.role;
    } else {
      // Multicliente futuro: any active membership is allowed.
      const member = await this.prisma.merchantMember.findFirst({
        where: { authUserId: userId, active: true },
      });
      if (!member) {
        throw new ApiException(
          'MERCHANT_ACCESS_DENIED',
          'Access to this merchant is not authorized',
          403,
        );
      }
      merchantId = member.merchantId;
      role = member.role;
    }

    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (adminOnly && role !== 'ADMIN') {
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'A merchant administrator is required',
        403,
      );
    }
    request.merchantActor = {
      userId,
      merchantId,
      role,
    };
    return true;
  }
}
