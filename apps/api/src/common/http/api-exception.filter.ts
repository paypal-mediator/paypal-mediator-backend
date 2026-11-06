import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiError } from '@resolve-ai/contracts';
import type { RequestWithId } from './request-id.middleware.js';
import { ApiException } from './api.exception.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<RequestWithId>();
    const requestId = request.requestId ?? randomUUID();
    const parserTooLarge =
      typeof exception === 'object' &&
      exception !== null &&
      'type' in exception &&
      exception.type === 'entity.too.large' &&
      'status' in exception &&
      exception.status === 413;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : parserTooLarge
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : HttpStatus.INTERNAL_SERVER_ERROR;
    const body: ApiError = {
      code: `HTTP_${status}`,
      message: status >= 500 ? 'Internal server error' : 'Request failed',
      requestId,
    };
    if (status < 500) {
      body.message = STATUS_CODES[status] ?? 'Request failed';
    }
    if (status === 503) {
      body.code = 'SERVICE_NOT_READY';
      body.message = 'Database is unavailable';
    }
    if (status >= 500) {
      if (exception instanceof ApiException) {
        body.code = exception.code;
        body.message = exception.publicMessage;
      }
      this.logger.error({ requestId, status, code: body.code });
    }
    if (exception instanceof ApiException && status < 500) {
      body.code = exception.code;
      body.message = exception.publicMessage;
    }
    response.status(status).json(body);
  }
}
