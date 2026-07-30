import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UzumService } from './uzum.service';
import { UzumCallbackDto } from './uzum.dto';
import { Public } from '../../../auth/decorators/public.decorator';

/**
 * Uzum Bank callback endpoint.
 *
 * See UzumService for the caveat about the wire contract: the operations and
 * signature base string follow Uzum's published checkout shape and must be
 * confirmed against the merchant agreement before go-live.
 */
@Controller('payments/uzum')
export class UzumController {
  constructor(private readonly uzum: UzumService) {}

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.OK)
  handle(@Body() dto: UzumCallbackDto) {
    return this.uzum.handle(dto);
  }
}
