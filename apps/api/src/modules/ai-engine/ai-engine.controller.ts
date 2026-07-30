import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UsageMetric } from '@legaltech/database';
import { AiEngineService } from './ai-engine.service';
import { GenerateDocumentDto } from './dto/generate-document.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import {
  ConsumesQuota,
  RequiresFeature,
} from '../billing/limits/plan-limit.decorator';
import { LEGAL_LOCALE_LABELS } from './prompts/legal-system-prompt';

@Controller('ai-engine')
export class AiEngineController {
  constructor(private readonly aiEngine: AiEngineService) {}

  /** Locales the engine can generate in. */
  @Get('locales')
  locales() {
    return Object.entries(LEGAL_LOCALE_LABELS).map(([code, label]) => ({
      code,
      label,
    }));
  }

  // Generation is the most expensive endpoint in the API — throttle it well
  // below the global default, and meter it against the caller's plan. The
  // throttle bounds burst rate; the quota bounds what the customer bought.
  @Roles('OWNER', 'ADMIN', 'ATTORNEY', 'PARALEGAL')
  @RequiresFeature('aiGeneration')
  @ConsumesQuota(UsageMetric.AI_GENERATIONS)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  generate(
    @Body() dto: GenerateDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Attribution comes from the token, never the body: a client-supplied
    // companyId would let one tenant charge their AI spend to another.
    return this.aiEngine.generateLegalDocument({
      ...dto,
      companyId: user.companyId,
      userId: user.id,
    });
  }
}
