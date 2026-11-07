import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError } from 'rxjs';
import { z } from 'zod';
import { ApiException } from '../../common/http/api.exception.js';
import type { MerchantRequest } from '../merchants/index.js';
import { AuditService } from './audit.service.js';

@Injectable()
export class AuditFailureInterceptor implements NestInterceptor {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<MerchantRequest>();
    const owner = context.getClass().name;
    const action =
      owner === 'MerchantsController'
        ? 'MERCHANT_ACTION_FAILED'
        : owner === 'InvestigatorController'
          ? 'INVESTIGATION_ACTION_FAILED'
          : owner === 'VerifierController'
            ? 'VERIFICATION_ACTION_FAILED'
            : owner === 'OrdersController'
              ? 'TRANSACTION_ACTION_FAILED'
              : owner === 'TransactionsController'
                ? [
                    'uploadFile',
                    'downloadFile',
                    'evidence',
                    'dossier',
                    'refresh',
                  ].includes(context.getHandler().name)
                  ? 'EVIDENCE_ACTION_FAILED'
                  : 'TRANSACTION_ACTION_FAILED'
                : null;
    return next.handle().pipe(
      catchError(async (error: unknown) => {
        // Guard failures have no trusted actor. Webhook failures are recorded by M02.
        if (request.merchantActor && action) {
          const status =
            error instanceof HttpException ? error.getStatus() : 500;
          const code =
            error instanceof ApiException &&
            /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
              ? error.code
              : `HTTP_${status}`;
          const transactionId =
            owner === 'TransactionsController'
              ? request.params.id
              : request.params.transactionId;
          const resourceType =
            owner === 'MerchantsController'
              ? 'MERCHANT'
              : owner === 'InvestigatorController'
                ? 'INVESTIGATION'
                : owner === 'VerifierController'
                  ? 'VERIFICATION'
                  : owner === 'OrdersController'
                    ? 'ORDER'
                    : request.params.evidenceId
                      ? 'EVIDENCE'
                      : 'TRANSACTION';
          const resourceId =
            resourceType === 'MERCHANT'
              ? request.merchantActor.merchantId
              : (request.params.evidenceId ?? request.params.id);
          await this.audit.append({
            merchantId: request.merchantActor.merchantId,
            actorUserId: request.merchantActor.userId,
            resourceType,
            resourceId: z.uuid().safeParse(resourceId).success
              ? (resourceId as string)
              : null,
            transactionId: z.uuid().safeParse(transactionId).success
              ? (transactionId as string)
              : null,
            outcome: status < 500 ? 'BLOCKED' : 'FAILED',
            record: {
              action,
              details: { errorCode: code, httpStatus: status },
            },
          });
        }
        throw error;
      }),
    );
  }
}
