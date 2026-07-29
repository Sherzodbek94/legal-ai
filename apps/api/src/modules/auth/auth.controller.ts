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
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { AuthService } from './auth.service';
import { OtpService } from './services/otp.service';
import { OneIdService } from './services/oneid.service';
import { TokenService, type IssuedTokens } from './services/token.service';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './interfaces/jwt-payload.interface';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
} from './constants';
import {
  LoginDto,
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
    private readonly config: ConfigService,
  ) {}

  private get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
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

  /** Revokes every session for the caller (e.g. "sign out everywhere"). */
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logoutAll(user.id);
    this.clearAuthCookies(res);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
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
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    const valid = await this.otpService.verifyOtp(dto.phone, dto.code);
    if (!valid) {
      throw new UnauthorizedException('Invalid code');
    }
    // Deliberately does not mint a session on its own: phone possession alone
    // does not identify an account here. The caller pairs this proof with a
    // registration or step-up flow.
    return { status: 'verified' };
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

  @Public()
  @Get('oneid/callback')
  async oneIdCallback(
    @Query() query: OneIdCallbackDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
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

    const tokens = await this.authService.loginWithVerifiedIdentity(
      profile.email,
      {
        name: [profile.lastName, profile.firstName].filter(Boolean).join(' '),
      },
      this.contextFrom(req),
    );

    this.setAuthCookies(res, tokens);
    return {
      status: 'authenticated',
      legalEntities: profile.legalEntities,
    };
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
