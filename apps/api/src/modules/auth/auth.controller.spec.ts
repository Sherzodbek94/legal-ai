/**
 * Session cookies and the endpoints that set them.
 *
 * The cookie attributes are the security boundary of the whole application, and
 * every one of them fails silently when wrong: drop `httpOnly` and any XSS
 * reads the session; drop `secure` and it crosses the network in clear; widen
 * `sameSite` on the refresh cookie and it rides along with cross-site requests;
 * widen its `path` and it is sent to every endpoint instead of the one that
 * redeems it. None of that changes a single response the tests or a browser
 * would otherwise notice.
 *
 * The pairing matters as much as the values. `clearCookie` has to repeat the
 * path and sameSite it was set with, or the browser matches nothing and the
 * "cleared" cookie is still on the next request — which is how a logout that
 * reports success leaves a live session behind.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
} from './constants';
import type { AuthService } from './auth.service';
import type { TokenService } from './services/token.service';
import type { OtpService } from './services/otp.service';
import type { OneIdService } from './services/oneid.service';
import type { GoogleOAuthService } from './services/google-oauth.service';
import type { CompanyService } from '../company/company.service';
import type { PrismaService } from '../../prisma/prisma.service';

const TOKENS = {
  accessToken: 'access-jwt',
  refreshToken: 'refresh-token',
  accessTokenExpiresIn: 900,
  refreshTokenExpiresAt: new Date('2026-08-12T00:00:00Z'),
};

type CookieCall = { name: string; value?: string; options: Record<string, unknown> };

/** An Express response that records what it was told to do. */
function fakeResponse() {
  const set: CookieCall[] = [];
  const cleared: CookieCall[] = [];
  const redirects: string[] = [];

  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      set.push({ name, value, options });
      return res;
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      cleared.push({ name, options });
      return res;
    },
    redirect: (url: string) => {
      redirects.push(url);
    },
  } as unknown as Response;

  return { res, set, cleared, redirects };
}

function fakeRequest(cookies: Record<string, string> = {}): Request {
  return {
    cookies,
    ip: '203.0.113.7',
    get: (header: string) => (header === 'user-agent' ? 'jest' : undefined),
  } as unknown as Request;
}

function build({
  production = false,
  services = {} as Record<string, unknown>,
} = {}) {
  const authService = {
    register: jest.fn(async () => TOKENS),
    login: jest.fn(async () => TOKENS),
    logout: jest.fn(async () => undefined),
    logoutAll: jest.fn(async () => undefined),
    loginWithVerifiedPhone: jest.fn(async () => ({ tokens: TOKENS, hasCompany: true })),
    loginWithGoogle: jest.fn(async () => ({ tokens: TOKENS, hasCompany: true })),
    ...(services.authService as object),
  };

  const tokenService = {
    rotateRefreshToken: jest.fn(async () => ({ tokens: TOKENS })),
    ...(services.tokenService as object),
  };

  const otpService = {
    isAvailable: () => true,
    requestOtp: jest.fn(async () => ({ expiresIn: 300, resendAfter: 60 })),
    verifyOtp: jest.fn(async () => true),
    normalizePhone: (phone: string) => phone.replace(/[^\d+]/g, ''),
    ...(services.otpService as object),
  };

  const google = {
    isConfigured: () => true,
    consumeState: jest.fn(async () => true),
    exchangeCode: jest.fn(async () => ({ subject: 'g-1', email: 'a@b.uz' })),
    buildAuthorizationUrl: jest.fn(async () => ({ url: 'https://accounts.google.com/x' })),
    ...(services.google as object),
  };

  const oneIdService = { isConfigured: () => true, ...(services.oneIdService as object) };

  const controller = new AuthController(
    authService as unknown as AuthService,
    tokenService as unknown as TokenService,
    otpService as unknown as OtpService,
    oneIdService as unknown as OneIdService,
    google as unknown as GoogleOAuthService,
    {} as unknown as CompanyService,
    {
      get: <T>(key: string, fallback?: T) =>
        (({
          NODE_ENV: production ? 'production' : 'test',
          WEB_APP_URL: 'https://app.legaltech.uz/',
        })[key] as T) ?? fallback,
    } as unknown as ConfigService,
    {} as unknown as PrismaService,
  );

  return { controller, authService, tokenService, otpService, google };
}

const byName = (calls: CookieCall[], name: string) =>
  calls.find((call) => call.name === name)!;

describe('AuthController', () => {
  describe('session cookies', () => {
    it('keeps both tokens out of reach of page JavaScript', async () => {
      // The single attribute standing between an XSS and every session.
      const { controller } = build();
      const { res, set } = fakeResponse();

      await controller.login({} as never, fakeRequest(), res);

      expect(set).toHaveLength(2);
      for (const cookie of set) {
        expect(cookie.options.httpOnly).toBe(true);
      }
    });

    it('marks them secure in production', async () => {
      const { controller } = build({ production: true });
      const { res, set } = fakeResponse();

      await controller.login({} as never, fakeRequest(), res);

      for (const cookie of set) {
        expect(cookie.options.secure).toBe(true);
      }
    });

    it('does not require HTTPS outside production, where there is none', async () => {
      const { controller } = build({ production: false });
      const { res, set } = fakeResponse();

      await controller.login({} as never, fakeRequest(), res);

      expect(byName(set, ACCESS_TOKEN_COOKIE).options.secure).toBe(false);
    });

    it('scopes the refresh cookie to the endpoint that redeems it', async () => {
      // Path plus strict sameSite: it is never attached to a cross-site
      // request, and never sent to any endpoint but /auth.
      const { controller } = build();
      const { res, set } = fakeResponse();

      await controller.login({} as never, fakeRequest(), res);

      const refresh = byName(set, REFRESH_TOKEN_COOKIE);
      expect(refresh.options.path).toBe(REFRESH_COOKIE_PATH);
      expect(refresh.options.sameSite).toBe('strict');
    });

    it('keeps the refresh cookie strict even outside production', async () => {
      // The access cookie relaxes to `lax` locally so an OAuth redirect can
      // carry it; the refresh cookie never does.
      const { controller } = build({ production: false });
      const { res, set } = fakeResponse();

      await controller.login({} as never, fakeRequest(), res);

      expect(byName(set, REFRESH_TOKEN_COOKIE).options.sameSite).toBe('strict');
      expect(byName(set, ACCESS_TOKEN_COOKIE).options.sameSite).toBe('lax');
    });

    it('sends the access cookie to the whole app', async () => {
      const { controller } = build();
      const { res, set } = fakeResponse();

      await controller.login({} as never, fakeRequest(), res);

      expect(byName(set, ACCESS_TOKEN_COOKIE).options.path).toBe('/');
    });

    it('expires each cookie with its own token', async () => {
      // A cookie outliving its token leaves the browser replaying something the
      // API already rejects; one expiring early logs the user out mid-session.
      const { controller } = build();
      const { res, set } = fakeResponse();

      await controller.login({} as never, fakeRequest(), res);

      expect(byName(set, ACCESS_TOKEN_COOKIE).options.maxAge).toBe(900 * 1000);
      expect(byName(set, REFRESH_TOKEN_COOKIE).options.expires).toEqual(
        TOKENS.refreshTokenExpiresAt,
      );
    });
  });

  describe('clearing them', () => {
    it('repeats the path and sameSite the cookies were set with', async () => {
      // Without the match the browser clears nothing, and a logout that reports
      // success leaves a live session behind.
      const { controller } = build();
      const { res, cleared } = fakeResponse();

      await controller.logout(fakeRequest({ [REFRESH_TOKEN_COOKIE]: 'rt' }), res);

      expect(byName(cleared, ACCESS_TOKEN_COOKIE).options.path).toBe('/');
      expect(byName(cleared, REFRESH_TOKEN_COOKIE).options).toMatchObject({
        path: REFRESH_COOKIE_PATH,
        sameSite: 'strict',
      });
    });

    it('revokes the presented token server-side, not just in the browser', async () => {
      // Clearing a cookie is a request to the browser. The token stays valid
      // until the server says otherwise.
      const { controller, authService } = build();
      const { res } = fakeResponse();

      await controller.logout(fakeRequest({ [REFRESH_TOKEN_COOKIE]: 'rt' }), res);

      expect(authService.logout).toHaveBeenCalledWith('rt');
    });

    it('still clears the cookies when none was presented', async () => {
      const { controller } = build();
      const { res, cleared } = fakeResponse();

      await controller.logout(fakeRequest(), res);

      expect(cleared).toHaveLength(2);
    });

    it('clears them on sign-out-everywhere too', async () => {
      const { controller, authService } = build();
      const { res, cleared } = fakeResponse();

      await controller.logoutAll({ id: 'user_1' } as never, res);

      expect(authService.logoutAll).toHaveBeenCalledWith('user_1');
      expect(cleared).toHaveLength(2);
    });
  });

  describe('refresh', () => {
    it('rotates and re-issues both cookies', async () => {
      const { controller, tokenService } = build();
      const { res, set } = fakeResponse();

      const result = await controller.refresh(
        fakeRequest({ [REFRESH_TOKEN_COOKIE]: 'rt' }),
        res,
      );

      expect(tokenService.rotateRefreshToken).toHaveBeenCalledWith(
        'rt',
        expect.objectContaining({ ipAddress: '203.0.113.7', userAgent: 'jest' }),
      );
      expect(result).toEqual({ status: 'refreshed' });
      expect(set).toHaveLength(2);
    });

    it('refuses without a cookie, without calling the token service', async () => {
      const { controller, tokenService } = build();
      const { res } = fakeResponse();

      await expect(controller.refresh(fakeRequest(), res)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(tokenService.rotateRefreshToken).not.toHaveBeenCalled();
    });

    it('drops the cookie when rotation is rejected', async () => {
      // A rejected refresh means the cookie is worthless. Left in place the
      // client replays it on every request, and a reused token is exactly what
      // rotation detection treats as theft.
      const { controller } = build({
        services: {
          tokenService: {
            rotateRefreshToken: jest.fn(async () => {
              throw new UnauthorizedException('Refresh token reused');
            }),
          },
        },
      });
      const { res, cleared } = fakeResponse();

      await expect(
        controller.refresh(fakeRequest({ [REFRESH_TOKEN_COOKIE]: 'rt' }), res),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(cleared).toHaveLength(2);
    });

    it('lets the original failure through rather than masking it', async () => {
      const { controller } = build({
        services: {
          tokenService: {
            rotateRefreshToken: jest.fn(async () => {
              throw new UnauthorizedException('Refresh token reused');
            }),
          },
        },
      });
      const { res } = fakeResponse();

      await expect(
        controller.refresh(fakeRequest({ [REFRESH_TOKEN_COOKIE]: 'rt' }), res),
      ).rejects.toThrow('Refresh token reused');
    });
  });

  describe('SMS sign-in', () => {
    it('signs the caller in on a correct code', async () => {
      // A correct code IS the sign-in: the number is unique and verified, so it
      // identifies exactly one account and the SMS proves possession.
      const { controller } = build();
      const { res, set } = fakeResponse();

      const result = await controller.verifyOtp(
        { phone: '+998901234567', code: '482913' } as never,
        fakeRequest(),
        res,
      );

      expect(result).toEqual({ status: 'authenticated', hasCompany: true });
      expect(set).toHaveLength(2);
    });

    it('issues nothing on a wrong code', async () => {
      const { controller, authService } = build({
        services: { otpService: { verifyOtp: jest.fn(async () => false) } },
      });
      const { res, set } = fakeResponse();

      await expect(
        controller.verifyOtp(
          { phone: '+998901234567', code: '000000' } as never,
          fakeRequest(),
          res,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(set).toHaveLength(0);
      expect(authService.loginWithVerifiedPhone).not.toHaveBeenCalled();
    });

    it('resolves the account through the same normalisation that stored it', async () => {
      // Otherwise `+998 90 123-45-67` and `+998901234567` are two accounts.
      const { controller, authService } = build();
      const { res } = fakeResponse();

      await controller.verifyOtp(
        { phone: '+998 90 123-45-67', code: '482913' } as never,
        fakeRequest(),
        res,
      );

      expect(authService.loginWithVerifiedPhone).toHaveBeenCalledWith(
        '+998901234567',
        expect.anything(),
      );
    });
  });

  describe('Google callback', () => {
    it('sends a returning user to the dashboard', async () => {
      const { controller } = build();
      const { res, redirects, set } = fakeResponse();

      await controller.googleCallback(
        { code: 'c', state: 's' } as never,
        fakeRequest(),
        res,
      );

      expect(set).toHaveLength(2);
      expect(redirects).toEqual(['https://app.legaltech.uz/dashboard']);
    });

    it('sends a user with no company to onboarding', async () => {
      // The dashboard would be an empty shell they cannot act on.
      const { controller } = build({
        services: {
          authService: {
            loginWithGoogle: jest.fn(async () => ({ tokens: TOKENS, hasCompany: false })),
          },
        },
      });
      const { res, redirects } = fakeResponse();

      await controller.googleCallback(
        { code: 'c', state: 's' } as never,
        fakeRequest(),
        res,
      );

      expect(redirects).toEqual(['https://app.legaltech.uz/onboarding']);
    });

    it('redirects rather than answering JSON', async () => {
      // Google sends the *browser* here; a JSON body strands the user on the
      // API's origin looking at a raw object.
      const { controller } = build();
      const { res, redirects } = fakeResponse();

      await controller.googleCallback(
        { code: 'c', state: 's' } as never,
        fakeRequest(),
        res,
      );

      expect(redirects).toHaveLength(1);
    });

    it('refuses a state it did not issue, and exchanges no code', async () => {
      // The CSRF guard on the whole flow: without it an attacker's code can be
      // redeemed into the victim's browser.
      const { controller, google } = build({
        services: { google: { consumeState: jest.fn(async () => false) } },
      });
      const { res, set } = fakeResponse();

      await expect(
        controller.googleCallback({ code: 'c', state: 'forged' } as never, fakeRequest(), res),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(google.exchangeCode).not.toHaveBeenCalled();
      expect(set).toHaveLength(0);
    });

    it('strips a trailing slash from the configured app URL', async () => {
      // `https://app.legaltech.uz//dashboard` is a different path to some
      // proxies and a 404 to others.
      const { controller } = build();
      const { res, redirects } = fakeResponse();

      await controller.googleCallback(
        { code: 'c', state: 's' } as never,
        fakeRequest(),
        res,
      );

      expect(redirects[0]).not.toContain('//dashboard');
    });
  });

  describe('advertised providers', () => {
    it('reports what this deployment can actually perform', async () => {
      // The sign-in page renders its alternatives from this. A button that only
      // discovers it is unusable once clicked reads as the app breaking.
      const { controller } = build();

      expect(controller.providers()).toEqual({
        password: true,
        sms: true,
        google: true,
        oneid: true,
      });
    });

    it('hides a method this deployment cannot perform', async () => {
      const { controller } = build({
        services: {
          google: { isConfigured: () => false },
          otpService: { isAvailable: () => false },
        },
      });

      expect(controller.providers()).toMatchObject({
        password: true,
        sms: false,
        google: false,
      });
    });

    it('names no configuration keys — it is public and unauthenticated', () => {
      const { controller } = build();

      const advertised = JSON.stringify(controller.providers());
      expect(advertised).not.toMatch(/CLIENT_ID|SECRET|TOKEN|KEY/i);
    });
  });

  describe('request context', () => {
    it('records the user agent and IP against a new session', async () => {
      // What makes "sign out everywhere" reviewable, and an unfamiliar session
      // recognisable.
      const { controller, authService } = build();
      const { res } = fakeResponse();

      await controller.login({} as never, fakeRequest(), res);

      expect(authService.login).toHaveBeenCalledWith(
        {},
        { userAgent: 'jest', ipAddress: '203.0.113.7' },
      );
    });
  });
});
