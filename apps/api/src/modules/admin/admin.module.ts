import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AnalyticsService } from './analytics/analytics.service';
import { AiCostService } from './analytics/ai-cost.service';
import { ModerationService } from './moderation/moderation.service';
import { AuditViewerService } from './audit/audit-viewer.service';
import { ImpersonationService } from './impersonation/impersonation.service';
import { ImpersonationGuard } from './impersonation/impersonation.guard';
import { AuthModule } from '../auth/auth.module';

/**
 * Platform administration.
 *
 * Global because `AiCostService` is called from the AI engine — the token counts
 * originate there, and having ai-engine import the whole admin module to record
 * a cost would invert the dependency for no benefit. This mirrors BillingModule,
 * which is global for the same reason.
 *
 * AuthModule is imported for `JwtService` (impersonation token signing) and
 * `TokenService` (revoking sessions when an account is locked).
 */
@Global()
@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [AdminController],
  providers: [
    AnalyticsService,
    AiCostService,
    ModerationService,
    AuditViewerService,
    ImpersonationService,
    ImpersonationGuard,
  ],
  exports: [
    AnalyticsService,
    AiCostService,
    ModerationService,
    AuditViewerService,
    ImpersonationService,
    ImpersonationGuard,
  ],
})
export class AdminModule {}
