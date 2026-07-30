import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ClickService } from './click.service';
import { ClickCallbackDto } from './click.dto';
import { Public } from '../../../auth/decorators/public.decorator';

/**
 * CLICK SHOP-API endpoints.
 *
 * Public because CLICK's servers call them with no session — authentication is
 * the MD5 signature on the payload, checked inside ClickService, and nothing
 * happens before that check passes.
 *
 * Both always answer HTTP 200. CLICK reads the outcome from the `error` field
 * in the body; a 4xx would be treated as a delivery failure and retried
 * forever, so even a rejected signature returns 200 with error -1.
 */
@Controller('payments/click')
export class ClickController {
  constructor(private readonly click: ClickService) {}

  @Public()
  // Generous: CLICK legitimately retries, and throttling a real callback into
  // failure is worse than absorbing a burst. This exists to bound abuse of a
  // public endpoint, not to shape gateway traffic.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('prepare')
  @HttpCode(HttpStatus.OK)
  prepare(@Body() dto: ClickCallbackDto) {
    return this.click.handlePrepare(dto);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  complete(@Body() dto: ClickCallbackDto) {
    return this.click.handleComplete(dto);
  }
}
