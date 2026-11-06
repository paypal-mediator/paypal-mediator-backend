import {
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  PayPalWebhookEnvelopeSchema,
  WebhookReceiptSchema,
} from '@resolve-ai/contracts';
import type { Request } from 'express';
import { ApiException } from '../../common/http/api.exception.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import { EventIngestionService } from './event-ingestion.service.js';

@ApiTags('event-ingestion')
@Controller('webhooks/paypal')
export class EventIngestionController {
  constructor(
    @Inject(EventIngestionService)
    private readonly ingestion: EventIngestionService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Verify a Sandbox PayPal webhook, persist it and durably enqueue supported events',
    description:
      'Public delivery endpoint authenticated by PayPal signature; no merchant JWT. Acknowledges only after the database transaction commits. Does not run investigations or downstream modules.',
  })
  @ApiHeader({ name: 'paypal-transmission-id', required: true })
  @ApiHeader({ name: 'paypal-transmission-time', required: true })
  @ApiHeader({ name: 'paypal-transmission-sig', required: true })
  @ApiHeader({ name: 'paypal-cert-url', required: true })
  @ApiHeader({ name: 'paypal-auth-algo', required: true })
  @ApiBody({ schema: zodOpenApi(PayPalWebhookEnvelopeSchema) })
  @ApiResponse({ status: 200, schema: zodOpenApi(WebhookReceiptSchema) })
  @ApiResponse({
    status: 400,
    description: 'Malformed headers or event envelope',
  })
  @ApiResponse({
    status: 401,
    description: 'PayPal explicitly rejected the signature',
  })
  @ApiResponse({
    status: 409,
    description: 'Verified event ID conflicts with stored content',
  })
  @ApiResponse({
    status: 503,
    description:
      'Merchant integration is unconfigured or PayPal verification is unavailable; retry',
  })
  receive(@Req() request: RawBodyRequest<Request>) {
    if (!request.is('application/json'))
      throw new ApiException(
        'UNSUPPORTED_WEBHOOK_CONTENT_TYPE',
        'Webhook deliveries require application/json',
        415,
      );
    return this.ingestion.receive(request.rawBody, request.headers);
  }
}
