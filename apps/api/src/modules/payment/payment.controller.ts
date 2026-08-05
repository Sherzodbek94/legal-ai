import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PaymentOrderService } from './orders/payment-order.service';
import { CreateOrderDto } from './orders/dto/create-order.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NoImpersonation } from '../admin/impersonation/no-impersonation.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

/**
 * Customer-facing order management.
 *
 * Distinct from the gateway callback controllers: this is authenticated and
 * tenant-scoped, whereas those are public and authenticated by signature.
 */
@Controller('payments/orders')
export class PaymentController {
  constructor(private readonly orders: PaymentOrderService) {}

  // Creating an order is the first step of taking money; not reachable while
  // impersonating.
  @Roles('OWNER')
  @NoImpersonation('payment:write')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.orders.create(dto, user);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.list(user.companyId!);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.findOne(id, user.companyId!);
  }

  // Cancelling is a money-write action too; not reachable while impersonating.
  @Roles('OWNER')
  @NoImpersonation('payment:write')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.cancel(id, user.companyId!);
  }
}
