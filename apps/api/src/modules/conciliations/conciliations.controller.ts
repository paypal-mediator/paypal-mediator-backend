import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ApproveContactReplySchema,
  ConciliationPolicySchema,
  ContactMessageSchema,
  CreateContactLinkSchema,
  type ConciliationPolicy,
} from '@resolve-ai/contracts';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  MerchantEditorOnly,
  type MerchantRequest,
} from '../merchants/index.js';
import { ConciliationsService } from './conciliations.service.js';

@Controller('conciliations')
@ApiTags('conciliations')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
export class ConciliationsController {
  constructor(
    @Inject(ConciliationsService)
    private readonly service: ConciliationsService,
  ) {}
  @Get('policy') policy(@Req() req: MerchantRequest) {
    return this.service.policy(req.merchantActor.merchantId);
  }
  @Put('policy')
  @MerchantAdminOnly()
  configure(
    @Req() req: MerchantRequest,
    @Body(new ZodValidationPipe(ConciliationPolicySchema))
    body: ConciliationPolicy,
  ) {
    return this.service.configure(req.merchantActor, body);
  }
  @Get() list(
    @Req() req: MerchantRequest,
    @Query('orderId', new ZodValidationPipe(z.uuid().optional()))
    orderId?: string,
    @Query('transactionId', new ZodValidationPipe(z.uuid().optional()))
    transactionId?: string,
  ) {
    return this.service.list(
      req.merchantActor.merchantId,
      orderId,
      transactionId,
    );
  }
  @Post('links')
  @MerchantEditorOnly()
  @Header('Cache-Control', 'no-store')
  create(
    @Req() req: MerchantRequest,
    @Body(new ZodValidationPipe(CreateContactLinkSchema))
    body: z.infer<typeof CreateContactLinkSchema>,
  ) {
    return this.service.createLink(
      req.merchantActor,
      body.orderId,
      body.expiresInDays,
      body.transactionId,
    );
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  view(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.service.view(req.merchantActor.merchantId, id);
  }
  @Post(':id/approve')
  @MerchantEditorOnly()
  approve(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(ApproveContactReplySchema))
    body: z.infer<typeof ApproveContactReplySchema>,
  ) {
    return this.service.approve(req.merchantActor, id, body);
  }
  @Post(':id/close')
  @MerchantEditorOnly()
  close(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.service.close(req.merchantActor, id);
  }
  @Post(':id/manual-review')
  @MerchantEditorOnly()
  manualReview(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.service.manualReview(req.merchantActor, id);
  }
  @Post(':id/revoke')
  @MerchantEditorOnly()
  revoke(
    @Req() req: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.service.close(req.merchantActor, id, true);
  }
}

// A random, expiring capability authorizes only ONE order conversation.
// The token travels in a header, never in an API URL or application log.
@Controller('public/conciliations')
@ApiTags('buyer-contact')
export class BuyerContactController {
  constructor(
    @Inject(ConciliationsService)
    private readonly service: ConciliationsService,
  ) {}
  @Get('chat')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  view(@Headers('x-chat-token') token = '') {
    return this.service.buyerView(token);
  }
  @Post('messages')
  @Header('Cache-Control', 'no-store')
  message(
    @Headers('x-chat-token') token: string = '',
    @Body(new ZodValidationPipe(ContactMessageSchema))
    body: z.infer<typeof ContactMessageSchema>,
  ) {
    return this.service.receive(token, body);
  }
}
