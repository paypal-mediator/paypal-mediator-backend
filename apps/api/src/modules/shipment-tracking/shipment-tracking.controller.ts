import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  ResolveShipmentTrackingSchema,
  ShipmentTrackingResponseSchema,
  type ResolveShipmentTracking,
} from '@resolve-ai/contracts';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  MerchantEditorOnly,
  type MerchantRequest,
} from '../merchants/index.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import { ShipmentTrackingService } from './shipment-tracking.service.js';
import { TrackingRegistrationService } from './tracking-registration.service.js';
import { TrackingWebhookService } from './tracking-webhook.service.js';

@ApiTags('shipment-tracking')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
@Controller()
export class ShipmentTrackingController {
  constructor(
    @Inject(ShipmentTrackingService)
    private readonly tracking: ShipmentTrackingService,
    @Inject(TrackingRegistrationService)
    private readonly registrations: TrackingRegistrationService,
  ) {}
  @Get('transactions/:id/shipment-tracking')
  @ApiOperation({
    summary: 'Read shipment tracking and provenance without external calls',
  })
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(ShipmentTrackingResponseSchema),
  })
  read(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.tracking.read(req.merchantActor.merchantId, id);
  }
  @Post('transactions/:id/shipment-tracking/resolve')
  @MerchantEditorOnly()
  @ApiBody({ schema: zodOpenApi(ResolveShipmentTrackingSchema) })
  @ApiOperation({
    summary: 'Resolve tracking: PayPal, ERP, then 17TRACK fallback',
  })
  @ApiResponse({
    status: 201,
    schema: zodOpenApi(ShipmentTrackingResponseSchema),
  })
  resolve(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(ResolveShipmentTrackingSchema))
    input: ResolveShipmentTracking,
  ) {
    return this.tracking.resolveShipmentTracking(
      req.merchantActor.merchantId,
      id,
      input,
    );
  }
  @Get('disputes/:id/shipment-tracking')
  @ApiResponse({
    status: 200,
    schema: zodOpenApi(ShipmentTrackingResponseSchema),
  })
  readDispute(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.tracking.readForDispute(req.merchantActor.merchantId, id);
  }
  @Post('disputes/:id/shipment-tracking/resolve')
  @MerchantEditorOnly()
  @ApiBody({ schema: zodOpenApi(ResolveShipmentTrackingSchema) })
  @ApiResponse({
    status: 201,
    schema: zodOpenApi(ShipmentTrackingResponseSchema),
  })
  resolveDispute(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(ResolveShipmentTrackingSchema))
    input: ResolveShipmentTracking,
  ) {
    return this.tracking.resolveForDispute(
      req.merchantActor.merchantId,
      id,
      input,
    );
  }
  @Get('shipment-tracking/usage')
  @MerchantAdminOnly()
  @ApiOperation({
    summary: 'Read today’s merchant tracking API consumption (UTC)',
  })
  usage(@Req() req: MerchantRequest) {
    return this.registrations.usage(req.merchantActor.merchantId);
  }
}
@ApiTags('shipment-tracking')
@Controller('webhooks/17track')
export class TrackingWebhookController {
  constructor(
    @Inject(TrackingWebhookService)
    private readonly webhooks: TrackingWebhookService,
  ) {}
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive signed 17TRACK v2.4 updates' })
  receive(@Req() req: RawBodyRequest<Request>) {
    return this.webhooks.receive(req.rawBody, req.get('sign'));
  }
}
