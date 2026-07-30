import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { StripeService } from './stripe.service';
import { Public } from '../../../auth/decorators/public.decorator';

/**
 * Stripe webhook endpoint.
 *
 * Reads `req.rawBody`, which requires `rawBody: true` on the Nest factory (see
 * main.ts). Stripe signs the exact bytes it posted; the parsed-and-re-
 * serialised body differs in key order and whitespace and would fail every
 * verification.
 *
 * Always answers 200, even on a rejected signature. Stripe retries non-2xx
 * responses with backoff for up to three days, so returning a 400 to a forged
 * request buys three days of pointless traffic and nothing else.
 */
@Controller('payments/stripe')
export class StripeController {
  constructor(private readonly stripe: StripeService) {}

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    return this.stripe.handleWebhook(request.rawBody, signature);
  }
}
