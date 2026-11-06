import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  CreateOrderSchema,
  OrderQuerySchema,
  OrderResponseSchema,
  OrderReceiptSchema,
  OrderListResponseSchema,
  type CreateOrder,
  type OrderQuery,
} from '@resolve-ai/contracts';
import {
  MerchantAccessGuard,
  MerchantAdminOnly,
  type MerchantRequest,
} from '../merchants/index.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { zodOpenApi } from '../../common/http/zod-openapi.js';
import { OrdersService } from './orders.service.js';

@ApiTags('orders')
@ApiBearerAuth('supabase')
@UseGuards(MerchantAccessGuard)
@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Post()
  @MerchantAdminOnly()
  @ApiOperation({
    summary:
      'Register an immutable merchant order and reconcile matching payments (ADMIN)',
  })
  @ApiBody({ schema: zodOpenApi(CreateOrderSchema) })
  @ApiResponse({ status: 201, schema: zodOpenApi(OrderReceiptSchema) })
  create(
    @Req() request: MerchantRequest,
    @Body(new ZodValidationPipe(CreateOrderSchema)) body: CreateOrder,
  ) {
    return this.orders.create(request.merchantActor, body);
  }

  @Get()
  @ApiResponse({ status: 200, schema: zodOpenApi(OrderListResponseSchema) })
  list(
    @Req() request: MerchantRequest,
    @Query(new ZodValidationPipe(OrderQuerySchema)) query: OrderQuery,
  ) {
    return this.orders.list(request.merchantActor.merchantId, query);
  }

  @Get(':id')
  @ApiResponse({ status: 200, schema: zodOpenApi(OrderResponseSchema) })
  detail(
    @Req() request: MerchantRequest,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ) {
    return this.orders.detail(request.merchantActor.merchantId, id);
  }
}
