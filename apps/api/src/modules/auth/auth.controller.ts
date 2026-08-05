import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';
import { OtpService } from './services/otp.service';
import { OneIdService } from './services/oneid.service';
import { GoogleOAuthService } from './services/google-oauth.service';
import { TokenService, type IssuedTokens } from './services/token.service';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { NoImpersonation } from '../admin/impersonation/no-impersonation.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './interfaces/jwt-payload.interface';
import { CompanyService } from '../company/company.service';
import { CreateCompanyDto } from '../company/dto/company.dto';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
} from './constants';
import {
  LoginDto,
  OAuthCallbackDto,
  OneIdCallbackDto,
  RegisterDto,
  RequestOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    private readonly otpService: OtpService,
    private readonly oneIdService: OneIdService,
    private readonly google: GoogleOAuthService,
    private readonly companyService: CompanyService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  private get webAppUrl(): string {
    return this.config
      .get<string>('WEB_APP_URL', 'http://localhost:3000')
      .replace(/\/+$/, '');
  }

  /**
   * Tokens live in HTTPOnly cookies so page JavaScript — including anything
   * injected via XSS — cannot read them.
   *
   * `sameSite: 'strict'` on the refresh cookie means it is never attached to
   * cross-site requests; combined with the `/auth` path scope, it only travels
   * to the endpoint that redeems it.
   */
  private baseCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: this.isProduction ? 'strict' : 'lax',
    };
  }

  private setAuthCookies(res: Response, tokens: IssuedTokens) {
    res.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
      ...this.baseCookieOptions(),
      path: '/',
      maxAge: tokens.accessTokenExpiresIn * 1000,
    });

    res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      ...this.baseCookieOptions(),
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: tokens.refreshTokenExpiresAt,
    });
  }

  private clearAuthCookies(res: Response) {
    // Clearing must repeat path/sameSite or the browser will not match the
    // cookie that was set.
    res.clearCookie(ACCESS_TOKEN_COOKIE, {
      ...this.baseCookieOptions(),
      path: '/',
    });
    res.clearCookie(REFRESH_TOKEN_COOKIE, {
      ...this.baseCookieOptions(),
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }

  private contextFrom(req: Request) {
    return {
      userAgent: req.get('user-agent') ?? undefined,
      ipAddress: req.ip,
    };
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  /**
   * Which sign-in methods this deployment can actually perform.
   *
   * The sign-in page renders its alternatives from this. Without it each button
   * only discovered it was unusable once clicked — the Google button answered
   * 503 and then removed itself, which reads as the app breaking rather than as
   * a method that was never on offer.
   *
   * Deliberately says nothing about *why* a method is unavailable, and names no
   * configuration keys: this is public and unauthenticated.
   */
  @Public()
  @Get('providers')
  providers() {
    return {
      password: true,
      sms: this.otpService.isAvailable(),
      google: this.google.isConfigured(),
      oneid: this.oneIdService.isConfigured(),
    };
  }

  // -------------------------------------------------------------------------
  // Password credentials
  // -------------------------------------------------------------------------

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.register(dto, this.contextFrom(req));
    this.setAuthCookies(res, tokens);
    return { status: 'registered' };
  }

  @Public()
  // Tighter than the global throttle: this endpoint guards a password.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.login(dto, this.contextFrom(req));
    this.setAuthCookies(res, tokens);
    return { status: 'authenticated' };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const presented = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!presented) {
      throw new UnauthorizedException('Missing refresh token');
    }

    try {
      const { tokens } = await this.tokenService.rotateRefreshToken(
        presented,
        this.contextFrom(req),
      );
      this.setAuthCookies(res, tokens);
      return { status: 'refreshed' };
    } catch (error) {
      // A rejected refresh means the cookie is worthless; drop it so the
      // client stops replaying it.
      this.clearAuthCookies(res);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(req.cookies?.[REFRESH_TOKEN_COOKIE]);
    this.clearAuthCookies(res);
  }

  /**
   * Revokes every session for the caller (e.g. "sign out everywhere").
   *
   * Blocked during impersonation: signing a customer out of all their devices is
   * both disruptive and indistinguishable, from their side, from a compromise.
   */
  @NoImpersonation('auth:credentials')
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logoutAll(user.id);
    this.clearAuthCookies(res);
  }

  /**
   * The current session, including the workspace it is scoped to.
   *
   * The company is included deliberately. Every page of the web app renders the
   * workspace name in its header, and without it here the frontend needs a
   * second round trip to `/companies/:id` on every single page load — a full
   * HTTP request, re-authenticated and re-validated, to learn one string. One
   * indexed lookup on this side replaces all of that.
   */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    // The phone is read from the row rather than the token: an account created
    // by SMS has no email, and the UI needs *something* to identify the signed
    // in person by. Adding it to the JWT instead would grow every request's
    // cookie for a value only this endpoint uses.
    const account = await this.prisma.client.user.findUnique({
      where: { id: user.id },
      select: { phone: true, name: true },
    });

    const company = user.companyId
      ? await this.prisma.client.company.findFirst({
          where: { id: user.companyId, deletedAt: null },
          select: { id: true, name: true, legalName: true },
        })
      : null;

    return { ...user, name: account?.name ?? null, phone: account?.phone ?? null, company };
  }

  /**
   * Creates the caller's first company and makes them its owner.
   *
   * No `@Roles` — there is nothing to require a role of yet, which is exactly
   * the gap this closes. `POST /companies` needs `@Roles('OWNER', 'ADMIN')`,
   * a role only an *existing* member can hold, so a freshly registered user
   * (password or OneID) previously had no way to ever become one. See
   * `CompanyService.registerAsOwner`.
   *
   * Reissues the session token pair with the new `companyId`/`companyRole`
   * so the caller does not have to log out and back in to use it.
   */
  @Post('company')
  @HttpCode(HttpStatus.CREATED)
  async createCompany(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCompanyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const company = await this.companyService.registerAsOwner(user.id, dto);

    const tokens = await this.tokenService.issueTokens(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        companyId: company.id,
        companyRole: 'OWNER',
      },
      this.contextFrom(req),
    );

    this.setAuthCookies(res, tokens);
    return { status: 'company_created', company };
  }

  // -------------------------------------------------------------------------
  // SMS OTP
  // -------------------------------------------------------------------------

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  async requestOtp(@Body() dto: RequestOtpDto) {
    return this.otpService.requestOtp(dto.phone);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const valid = await this.otpService.verifyOtp(dto.phone, dto.code);
    if (!valid) {
      throw new UnauthorizedException('Invalid code');
    }

    /*
     * A correct code IS the sign-in.
     *
     * This used to stop at `{ status: 'verified' }` on the reasoning that
     * phone possession alone does not identify an account — true when no
     * account was keyed on a phone number. `User.phone` is now unique and
     * verified, so the number identifies exactly one account, and the SMS is
     * the proof of possession. Anything further would be a second factor, not
     * a first.
     *
     * Normalised through the same function that wrote the stored number, so
     * `+998 90 123-45-67` and `+998901234567` resolve to one account.
     */
    const phone = this.otpService.normalizePhone(dto.phone);
    const { tokens, hasCompany } = await this.authService.loginWithVerifiedPhone(
      phone,
      this.contextFrom(req),
    );

    this.setAuthCookies(res, tokens);
    return { status: 'authenticated', hasCompany };
  }

  // -------------------------------------------------------------------------
  // Google
  // -------------------------------------------------------------------------

  @Public()
  @Get('google/authorize')
  async googleAuthorize() {
    if (!this.google.isConfigured()) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured on this deployment',
      );
    }
    const { url } = await this.google.buildAuthorizationUrl();
    return { url };
  }

  /**
   * Redirects the browser back into the web app, like the OneID callback —
   * Google sends the *browser* here, so answering with JSON would strand the
   * user on the API's origin looking at a raw object.
   */
  @Public()
  @Get('google/callback')
  async googleCallback(
    @Query() query: OAuthCallbackDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const stateValid = await this.google.consumeState(query.state);
    if (!stateValid) {
      throw new UnauthorizedException('Invalid or expired authorization state');
    }

    const profile = await this.google.exchangeCode(query.code);

    const { tokens, hasCompany } = await this.authService.loginWithGoogle(
      profile,
      this.contextFrom(req),
    );

    this.setAuthCookies(res, tokens);
    res.redirect(`${this.webAppUrl}${hasCompany ? '/dashboard' : '/onboarding'}`);
  }

  // -------------------------------------------------------------------------
  // OneID (id.egov.uz)
  // -------------------------------------------------------------------------

  @Public()
  @Get('oneid/authorize')
  async oneIdAuthorize() {
    const { url } = await this.oneIdService.buildAuthorizationUrl();
    return { url };
  }

  /**
   * Returns to the browser, not JSON to a fetch caller — `ONEID_REDIRECT_URI`
   * points here because id.egov.uz redirects the browser itself after the
   * citizen authenticates there. Previously this handler answered with a raw
   * JSON body, which meant the browser landed on the API's own origin
   * showing `{"status":"authenticated",...}` and never actually reached the
   * web app. `@Res()` without `passthrough` because a redirect is the one
   * thing passthrough mode does not reliably hand back to Nest's own
   * response handling.
   */
  @Public()
  @Get('oneid/callback')
  async oneIdCallback(
    @Query() query: OneIdCallbackDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const stateValid = await this.oneIdService.consumeState(query.state);
    if (!stateValid) {
      throw new UnauthorizedException('Invalid or expired authorization state');
    }

    const profile = await this.oneIdService.exchangeCode(query.code);

    if (!profile.email) {
      throw new UnauthorizedException(
        'OneID profile has no email address; cannot provision an account',
      );
    }

    const { tokens, userId, hasCompany } =
      await this.authService.loginWithVerifiedIdentity(
        profile.email,
        profile.userId,
        {
          name: [profile.lastName, profile.firstName].filter(Boolean).join(' '),
        },
        this.contextFrom(req),
      );

    this.setAuthCookies(res, tokens);

    if (!hasCompany) {
      // Held for the onboarding page to prefill company details from — see
      // `consumeLegalEntities`. Not sent as a redirect query param: STIR and
      // legal-entity affiliation do not belong in a URL that ends up in
      // server logs and browser history.
      await this.oneIdService.cacheLegalEntities(userId, profile.legalEntities);
    }

    res.redirect(`${this.webAppUrl}${hasCompany ? '/dashboard' : '/onboarding'}`);
  }

  /**
   * One-shot prefill for the onboarding form: whatever `legalEntities`
   * OneID returned on this session's login, consumed so a second read (a
   * page refresh) gets nothing rather than stale data from a different login.
   */
  @Get('oneid/legal-entities')
  async oneIdLegalEntities(@CurrentUser() user: AuthenticatedUser) {
    return { legalEntities: await this.oneIdService.consumeLegalEntities(user.id) };
  }

  // -------------------------------------------------------------------------
  // Example of tenant-role enforcement
  // -------------------------------------------------------------------------

  @Roles('OWNER', 'ADMIN')
  @Get('admin/sessions')
  adminOnly(@CurrentUser() user: AuthenticatedUser) {
    return { status: 'ok', companyId: user.companyId };
  }
}
