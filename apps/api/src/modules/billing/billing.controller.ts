import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SubscriptionPlan } from '@legaltech/database';
import { BillingService } from './billing.service';
import { SubscriptionService } from './subscription/subscription.service';
import { UsageService } from './limits/usage.service';
import { CouponService } from './coupons/coupon.service';
import { getPlan } from './plans/plan-catalog';
import {
  ApplyCouponDto,
  CancelSubscriptionDto,
  ChangePlanDto,
} from './dto/billing.dto';
import { CreateCouponDto, PreviewCouponDto } from './coupons/dto/coupon.dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { NoImpersonation } from '../admin/impersonation/no-impersonation.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly subscriptions: SubscriptionService,
    private readonly usage: UsageService,
    private readonly coupons: CouponService,
  ) {}

  // ---------------------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------------------

  /** Public: the pricing page is rendered before anyone has an account. */
  @Public()
  @Get('plans')
  getPlans() {
    return this.billing.getPlans();
  }

  @Public()
  @Get('plans/:plan')
  getPlan(
    @Param('plan', new ParseEnumPipe(SubscriptionPlan)) plan: SubscriptionPlan,
  ) {
    return this.billing.getPlanDetail(plan);
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.getOverview(user.companyId!);
  }

  @Get('usage')
  usageSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.usage.getUsageSummary(user.companyId!);
  }

  @Get('transactions')
  transactions(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.listTransactions(user.companyId!);
  }

  // Only an owner commits the company to a spend. @NoImpersonation on the
  // writes: a support engineer inside a customer's account must not be able to
  // change what that customer is paying, and the customer would have no way to
  // tell afterwards that it was not them.
  @Roles('OWNER')
  @NoImpersonation('billing:write')
  @Post('subscription')
  @HttpCode(HttpStatus.OK)
  changePlan(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePlanDto,
  ) {
    return this.subscriptions.changePlan(user.companyId!, dto, user);
  }

  @Roles('OWNER')
  @NoImpersonation('billing:write')
  @Delete('subscription')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CancelSubscriptionDto,
  ) {
    return this.subscriptions.cancel(
      user.companyId!,
      dto.immediately ?? false,
      user,
    );
  }

  @Roles('OWNER')
  @NoImpersonation('billing:write')
  @Post('subscription/resume')
  @HttpCode(HttpStatus.OK)
  resume(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.resume(user.companyId!, user);
  }

  // ---------------------------------------------------------------------------
  // Coupons
  // ---------------------------------------------------------------------------

  /**
   * Checks a code without consuming it.
   *
   * Throttled tightly: this endpoint tells you whether an arbitrary string is a
   * valid promo code, which is a brute-force oracle if left open.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('coupons/preview')
  @HttpCode(HttpStatus.OK)
  previewCoupon(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PreviewCouponDto,
  ) {
    const definition = getPlan(dto.plan);
    return this.coupons.preview(
      dto.code,
      user.companyId!,
      dto.plan,
      definition.monthlyPriceCents,
      dto.currency ?? definition.currency,
    );
  }

  @Roles('OWNER')
  @NoImpersonation('billing:write')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('coupons/apply')
  @HttpCode(HttpStatus.OK)
  applyCoupon(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApplyCouponDto,
  ) {
    return this.subscriptions.applyCoupon(user.companyId!, dto.code, user);
  }

  // --- Coupon administration (platform staff) --------------------------------

  @Roles('SUPER_ADMIN')
  @Post('admin/coupons')
  createCoupon(@Body() dto: CreateCouponDto) {
    return this.coupons.create(dto);
  }

  @Roles('SUPER_ADMIN')
  @Get('admin/coupons')
  listCoupons() {
    return this.coupons.list();
  }

  @Roles('SUPER_ADMIN')
  @Delete('admin/coupons/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deactivateCoupon(@Param('id') id: string) {
    return this.coupons.deactivate(id);
  }
}
