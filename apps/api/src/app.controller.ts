import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './modules/auth/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** Unauthenticated so load balancers and probes can reach it. */
  @Public()
  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }
}
