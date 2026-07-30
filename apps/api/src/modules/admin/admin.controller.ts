import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { AnalyticsService } from './analytics/analytics.service';
import { AiCostService } from './analytics/ai-cost.service';
import { ModerationService } from './moderation/moderation.service';
import { AuditViewerService } from './audit/audit-viewer.service';
import { ImpersonationService } from './impersonation/impersonation.service';
import { NoImpersonation } from './impersonation/no-impersonation.decorator';
import { calendarMonth } from '../billing/limits/billing-period';
import {
  AuditQuery,
  CostWindowQuery,
  ListQuery,
  LockDto,
  StartImpersonationDto,
} from './dto/admin.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ACCESS_TOKEN_COOKIE } from '../auth/constants';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

/**
 * Platform administration.
 *
 * `@Roles('SUPER_ADMIN')` sits on the class, so every route inherits it and a
 * new endpoint cannot be added without the restriction. RolesGuard treats
 * SUPER_ADMIN as satisfying any requirement, which is what makes a
 * class-level annotation sufficient here.
 */
@Roles('SUPER_ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly aiCosts: AiCostService,
    private readonly moderation: ModerationService,
    private readonly audit: AuditViewerService,
    private readonly impersonation: ImpersonationService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Analytics
  // ---------------------------------------------------------------------------

  @Get('dashboard')
  dashboard() {
    return this.analytics.getDashboard();
  }

  @Get('analytics/revenue')
  revenue() {
    return this.analytics.getRevenueSnapshot();
  }

  @Get('analytics/movement')
  movement() {
    return this.analytics.getMrrMovement();
  }

  // ---------------------------------------------------------------------------
  // AI cost tracking
  // ---------------------------------------------------------------------------

  @Get('ai-costs')
  aiCostSummary(@Query() query: CostWindowQuery) {
    const { from, to } = this.resolveWindow(query);
    return this.aiCosts.getSummary(from, to);
  }

  @Get('ai-costs/by-company')
  aiCostByCompany(@Query() query: CostWindowQuery) {
    const { from, to } = this.resolveWindow(query);
    return this.aiCosts.getCostByCompany(from, to, query.take);
  }

  @Get('ai-costs/daily')
  aiCostDaily(@Query() query: CostWindowQuery) {
    const { from, to } = this.resolveWindow(query);
    return this.aiCosts.getDailySeries(from, to);
  }

  // ---------------------------------------------------------------------------
  // Moderation
  // ---------------------------------------------------------------------------

  @Get('users')
  listUsers(@Query() query: ListQuery) {
    return this.moderation.listUsers(query);
  }

  @Post('users/:id/lock')
  @HttpCode(HttpStatus.NO_CONTENT)
  lockUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: LockDto,
  ) {
    return this.moderation.lockUser(id, dto, user);
  }

  @Delete('users/:id/lock')
  @HttpCode(HttpStatus.NO_CONTENT)
  unlockUser(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.moderation.unlockUser(id, user);
  }

  @Get('companies')
  listCompanies(@Query() query: ListQuery) {
    return this.moderation.listCompanies(query);
  }

  @Post('companies/:id/lock')
  @HttpCode(HttpStatus.OK)
  lockCompany(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: LockDto,
  ) {
    return this.moderation.lockCompany(id, dto, user);
  }

  @Delete('companies/:id/lock')
  @HttpCode(HttpStatus.NO_CONTENT)
  unlockCompany(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.moderation.unlockCompany(id, user);
  }

  // ---------------------------------------------------------------------------
  // Audit log
  // ---------------------------------------------------------------------------

  @Get('audit')
  auditLog(@Query() query: AuditQuery) {
    return this.audit.list(query);
  }

  @Get('audit/filters')
  auditFilters() {
    return this.audit.getFilterOptions();
  }

  @Get('audit/security')
  securityEvents() {
    return this.audit.listSecurityEvents();
  }

  // ---------------------------------------------------------------------------
  // Impersonation
  // ---------------------------------------------------------------------------

  /**
   * Starts a 15-minute impersonation session.
   *
   * `@NoImpersonation` blocks this from inside an existing session — the policy
   * refuses nesting too, but the guard makes it unreachable rather than merely
   * rejected, which is the safer arrangement for the one route that mints
   * credentials.
   *
   * Throttled hard. This is the highest-privilege operation in the system, and a
   * script hammering it is not a legitimate support workflow.
   */
  @NoImpersonation('impersonation:start')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('impersonation')
  @HttpCode(HttpStatus.OK)
  async startImpersonation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StartImpersonationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const issued = await this.impersonation.start(dto.targetUserId, dto.reason, user, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    // Replaces the operator's own access cookie for the session's lifetime. No
    // refresh cookie is set: the session must expire rather than roll over, and
    // the operator's original refresh cookie is untouched so ending the session
    // restores them by refreshing.
    res.cookie(ACCESS_TOKEN_COOKIE, issued.accessToken, this.cookieOptions(issued.expiresAt));

    return {
      sessionId: issued.sessionId,
      expiresAt: issued.expiresAt,
      expiresInSeconds: issued.expiresInSeconds,
      target: issued.target,
    };
  }

  @Get('impersonation/active')
  activeImpersonations() {
    return this.impersonation.listActive();
  }

  @Get('impersonation/history')
  impersonationHistory() {
    return this.impersonation.listHistory();
  }

  @Delete('impersonation/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async endImpersonation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.impersonation.end(id, user);

    // Clearing the cookie leaves the browser with only the operator's untouched
    // refresh cookie, so /auth/refresh returns them to their own identity.
    res.clearCookie(ACCESS_TOKEN_COOKIE, { ...this.cookieOptions(new Date()), maxAge: undefined });
  }

  /** Break-glass: kills every live session for an operator. */
  @Post('impersonation/revoke-all/:impersonatorId')
  @HttpCode(HttpStatus.OK)
  revokeAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('impersonatorId') impersonatorId: string,
  ) {
    return this.impersonation.revokeAllFor(impersonatorId, user);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private cookieOptions(expires: Date): CookieOptions {
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';

    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      path: '/',
      expires,
    };
  }

  /** Defaults to the current calendar month when no window is given. */
  private resolveWindow(query: CostWindowQuery): { from: Date; to: Date } {
    if (query.from && query.to) return { from: query.from, to: query.to };

    const month = calendarMonth(new Date());
    return { from: query.from ?? month.start, to: query.to ?? month.end };
  }
}
