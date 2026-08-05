/**
 * Auth, end to end, against a real database.
 *
 * These are the tests the unit suite cannot write. Refresh-token rotation, reuse
 * detection, and account locking are all *stateful* — their correctness lives in
 * rows and in what a second request sees after the first one committed. An
 * in-memory fake proves the code calls the right methods; only a real database
 * proves the behaviour.
 *
 * Requires:  docker compose up -d postgres-test redis
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { UserRole } from '@legaltech/database';
import {
  closeDb,
  cookieAttributes,
  createTestApp,
  db,
  readCookie,
  server,
  truncateAll,
} from './helpers';

const PASSWORD = 'CorrectHorse1!';

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  async function seedUser(overrides: Partial<{ email: string; locked: boolean }> = {}) {
    const email = overrides.email ?? 'user@acme-legal.uz';

    const company = await db().company.create({
      data: { name: 'Acme Legal', slug: `acme-${Date.now()}` },
    });

    const user = await db().user.create({
      data: {
        email,
        name: 'Test User',
        passwordHash: await bcrypt.hash(PASSWORD, 12),
        role: UserRole.USER,
        emailVerified: new Date(),
        ...(overrides.locked
          ? { lockedAt: new Date(), lockedReason: 'suspended for testing' }
          : {}),
      },
    });

    await db().companyMember.create({
      data: { companyId: company.id, userId: user.id, role: 'OWNER', joinedAt: new Date() },
    });

    return { user, company, email };
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe('POST /api/auth/register', () => {
    it('creates an account and sets both cookies', async () => {
      const response = await request(server(app))
        .post('/api/auth/register')
        .send({ email: 'new@acme-legal.uz', password: PASSWORD, name: 'New User' })
        .expect(201);

      expect(response.body).toEqual({ status: 'registered' });

      const cookies = response.headers['set-cookie'];
      expect(readCookie(cookies, 'access_token')).toBeTruthy();
      expect(readCookie(cookies, 'refresh_token')).toBeTruthy();
    });

    it('stores a bcrypt hash, never the password', async () => {
      await request(server(app))
        .post('/api/auth/register')
        .send({ email: 'hash@acme-legal.uz', password: PASSWORD })
        .expect(201);

      const user = await db().user.findUnique({
        where: { email: 'hash@acme-legal.uz' },
        select: { passwordHash: true },
      });

      expect(user!.passwordHash).not.toBe(PASSWORD);
      expect(user!.passwordHash).toMatch(/^\$2[aby]\$/);
    });

    it('scopes the refresh cookie to /api/auth and marks it HTTPOnly', async () => {
      const response = await request(server(app))
        .post('/api/auth/register')
        .send({ email: 'scoped@acme-legal.uz', password: PASSWORD })
        .expect(201);

      const refresh = cookieAttributes(response.headers['set-cookie'], 'refresh_token');

      // Path scoping is what keeps the refresh token off every ordinary API call.
      expect(refresh).toContain('HttpOnly');
      expect(refresh).toMatch(/Path=\/(api\/)?auth/);
    });

    it('rejects a duplicate email', async () => {
      await seedUser({ email: 'taken@acme-legal.uz' });

      await request(server(app))
        .post('/api/auth/register')
        .send({ email: 'taken@acme-legal.uz', password: PASSWORD })
        .expect(409);
    });

    it('rejects a weak password', async () => {
      await request(server(app))
        .post('/api/auth/register')
        .send({ email: 'weak@acme-legal.uz', password: '123' })
        .expect(400);
    });

    it('rejects unknown fields', async () => {
      // forbidNonWhitelisted on the global pipe. A silently-dropped field is how
      // a client believes it set something it did not.
      await request(server(app))
        .post('/api/auth/register')
        .send({ email: 'x@acme-legal.uz', password: PASSWORD, role: 'SUPER_ADMIN' })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Company onboarding
  //
  // Before this endpoint existed, no freshly registered account — by password
  // or by OneID — could ever become the owner of anything: `POST /companies`
  // requires `@Roles('OWNER', 'ADMIN')`, a role only an existing member can
  // hold, and `CompanyService.create()` never wrote the `CompanyMember` row
  // even for a caller who somehow had one. Only the seed script ever produced
  // a working account. This is the regression suite for that fix.
  // ---------------------------------------------------------------------------

  describe('POST /api/auth/company', () => {
    async function registerBareAccount(email: string) {
      const response = await request(server(app))
        .post('/api/auth/register')
        .send({ email, password: PASSWORD })
        .expect(201);

      return { access: readCookie(response.headers['set-cookie'], 'access_token')! };
    }

    it('makes a freshly registered user the owner of a new company', async () => {
      const { access } = await registerBareAccount('bootstrap@acme-legal.uz');

      const response = await request(server(app))
        .post('/api/auth/company')
        .set('Cookie', `access_token=${access}`)
        .send({ name: 'Bootstrap Legal', slug: `bootstrap-${Date.now()}` })
        .expect(201);

      expect(response.body.status).toBe('company_created');
      expect(response.body.company.name).toBe('Bootstrap Legal');

      const membership = await db().companyMember.findFirst({
        where: { companyId: response.body.company.id },
      });
      expect(membership?.role).toBe('OWNER');
    });

    it('reissues the session so /auth/me reflects the new company without a re-login', async () => {
      const { access } = await registerBareAccount('reissue@acme-legal.uz');

      // Before onboarding: authenticated, but no company.
      const before = await request(server(app))
        .get('/api/auth/me')
        .set('Cookie', `access_token=${access}`)
        .expect(200);
      expect(before.body.company).toBeNull();

      const created = await request(server(app))
        .post('/api/auth/company')
        .set('Cookie', `access_token=${access}`)
        .send({ name: 'Reissue Co', slug: `reissue-${Date.now()}` })
        .expect(201);

      const newAccess = readCookie(created.headers['set-cookie'], 'access_token')!;
      // Old token still carries no companyId — a live document of the moment
      // it was issued, not a promise to reflect what happens after.
      expect(newAccess).not.toBe(access);

      const after = await request(server(app))
        .get('/api/auth/me')
        .set('Cookie', `access_token=${newAccess}`)
        .expect(200);
      expect(after.body.company).toMatchObject({ name: 'Reissue Co' });
      expect(after.body.companyRole).toBe('OWNER');
    });

    it('refuses a second company for an account that already has one', async () => {
      const { email } = await seedUser({ email: 'already-owns@acme-legal.uz' });
      const login = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });
      const access = readCookie(login.headers['set-cookie'], 'access_token')!;

      await request(server(app))
        .post('/api/auth/company')
        .set('Cookie', `access_token=${access}`)
        .send({ name: 'Second Company', slug: `second-${Date.now()}` })
        .expect(409);
    });

    it('rejects an unauthenticated request', async () => {
      await request(server(app))
        .post('/api/auth/company')
        .send({ name: 'No Session Co', slug: `no-session-${Date.now()}` })
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  describe('POST /api/auth/login', () => {
    it('authenticates with correct credentials', async () => {
      const { email } = await seedUser();

      const response = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);

      expect(response.body).toEqual({ status: 'authenticated' });
      expect(readCookie(response.headers['set-cookie'], 'access_token')).toBeTruthy();
    });

    it('rejects a wrong password', async () => {
      const { email } = await seedUser();

      await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: 'WrongPassword1!' })
        .expect(401);
    });

    it('gives the same answer for an unknown account as for a wrong password', async () => {
      const { email } = await seedUser();

      const wrongPassword = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: 'WrongPassword1!' });

      const unknownUser = await request(server(app))
        .post('/api/auth/login')
        .send({ email: 'nobody@acme-legal.uz', password: PASSWORD });

      // Identical status and body: anything else turns the endpoint into an
      // account-enumeration oracle.
      //
      // `timestamp` is excluded because AllExceptionsFilter stamps every error
      // with the current time, so two sequential requests can never produce
      // byte-identical bodies. Comparing the whole body failed on a 238ms
      // difference while the property under test — that the two cases are
      // indistinguishable — held perfectly.
      const withoutTimestamp = (body: Record<string, unknown>) => {
        const { timestamp: _timestamp, ...rest } = body;
        return rest;
      };

      expect(unknownUser.status).toBe(wrongPassword.status);
      expect(withoutTimestamp(unknownUser.body)).toEqual(
        withoutTimestamp(wrongPassword.body),
      );
    });

    it('records the sign-in time', async () => {
      const { email, user } = await seedUser();

      await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);

      const after = await db().user.findUnique({
        where: { id: user.id },
        select: { lastLoginAt: true },
      });
      expect(after!.lastLoginAt).toBeInstanceOf(Date);
    });

    it('persists exactly one refresh token per sign-in', async () => {
      const { email, user } = await seedUser();

      await request(server(app)).post('/api/auth/login').send({ email, password: PASSWORD });
      await request(server(app)).post('/api/auth/login').send({ email, password: PASSWORD });

      const count = await db().refreshToken.count({ where: { userId: user.id } });
      expect(count).toBe(2);
    });

    it('stores only a hash of the refresh token', async () => {
      const { email, user } = await seedUser();

      const response = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });

      const presented = readCookie(response.headers['set-cookie'], 'refresh_token')!;
      const stored = await db().refreshToken.findFirst({
        where: { userId: user.id },
        select: { tokenHash: true },
      });

      // A database disclosure must not yield a replayable credential.
      expect(stored!.tokenHash).not.toBe(presented);
      expect(stored!.tokenHash).toHaveLength(64); // sha256 hex
    });
  });

  // ---------------------------------------------------------------------------
  // Refresh rotation
  // ---------------------------------------------------------------------------

  describe('POST /api/auth/refresh', () => {
    async function signIn() {
      const { email, user } = await seedUser();
      const response = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });

      return {
        user,
        refresh: readCookie(response.headers['set-cookie'], 'refresh_token')!,
      };
    }

    it('issues a new pair', async () => {
      const { refresh } = await signIn();

      const response = await request(server(app))
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${refresh}`)
        .expect(200);

      expect(response.body).toEqual({ status: 'refreshed' });

      const rotated = readCookie(response.headers['set-cookie'], 'refresh_token');
      expect(rotated).toBeTruthy();
      expect(rotated).not.toBe(refresh);
    });

    it('marks the presented token spent', async () => {
      const { refresh, user } = await signIn();

      await request(server(app))
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${refresh}`)
        .expect(200);

      const revoked = await db().refreshToken.count({
        where: { userId: user.id, revokedAt: { not: null } },
      });
      expect(revoked).toBe(1);
    });

    it('revokes EVERY session when a spent token is replayed', async () => {
      // Reuse detection, per OAuth 2.0 BCP §4.14.2. A replayed token means either
      // the store leaked or a session was cloned, and there is no way to tell
      // which — so every session is invalidated rather than guessing.
      const { refresh, user } = await signIn();

      await request(server(app))
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${refresh}`)
        .expect(200);

      // Replay the original.
      await request(server(app))
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${refresh}`)
        .expect(401);

      const live = await db().refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      });
      expect(live).toBe(0);
    });

    it('clears the cookies when refresh is refused', async () => {
      const response = await request(server(app))
        .post('/api/auth/refresh')
        .set('Cookie', 'refresh_token=not-a-real-token')
        .expect(401);

      // A worthless cookie must be dropped, or the client replays it forever.
      const cleared = response.headers['set-cookie'];
      expect(cleared).toBeDefined();
    });

    it('rejects a request with no refresh cookie', async () => {
      await request(server(app)).post('/api/auth/refresh').expect(401);
    });

    it('rejects an expired token', async () => {
      const { refresh, user } = await signIn();

      await db().refreshToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(server(app))
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${refresh}`)
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  describe('GET /api/auth/me', () => {
    it('returns the authenticated principal', async () => {
      const { email, user } = await seedUser();

      const login = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });

      const access = readCookie(login.headers['set-cookie'], 'access_token')!;

      const response = await request(server(app))
        .get('/api/auth/me')
        .set('Cookie', `access_token=${access}`)
        .expect(200);

      expect(response.body).toMatchObject({ id: user.id, email });
    });

    it('rejects an unauthenticated request', async () => {
      await request(server(app)).get('/api/auth/me').expect(401);
    });

    it('accepts a bearer token as well as a cookie', async () => {
      const { email } = await seedUser();

      const login = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });

      const access = readCookie(login.headers['set-cookie'], 'access_token')!;

      await request(server(app))
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${access}`)
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Locking
  // ---------------------------------------------------------------------------

  describe('account locking', () => {
    it('refuses an existing token immediately once the account is locked', async () => {
      // The reason JwtStrategy queries the database on every request. A purely
      // stateless check would leave a suspended account working until its token
      // expired — up to fifteen minutes of continued access after an operator
      // hit "lock", which is exactly the window that matters.
      const { email, user } = await seedUser();

      const login = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });
      const access = readCookie(login.headers['set-cookie'], 'access_token')!;

      await request(server(app))
        .get('/api/auth/me')
        .set('Cookie', `access_token=${access}`)
        .expect(200);

      await db().user.update({
        where: { id: user.id },
        data: { lockedAt: new Date(), lockedReason: 'abuse' },
      });

      // Same token, no re-login, no waiting for expiry.
      await request(server(app))
        .get('/api/auth/me')
        .set('Cookie', `access_token=${access}`)
        .expect(401);
    });

    it('refuses every member when the company is locked', async () => {
      const { email, company } = await seedUser();

      const login = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });
      const access = readCookie(login.headers['set-cookie'], 'access_token')!;

      await db().company.update({
        where: { id: company.id },
        data: { lockedAt: new Date(), lockedReason: 'non-payment' },
      });

      await request(server(app))
        .get('/api/auth/me')
        .set('Cookie', `access_token=${access}`)
        .expect(401);
    });

    it('refuses login for a locked account', async () => {
      const { email } = await seedUser({ locked: true });

      const response = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });

      expect([401, 403]).toContain(response.status);
    });
  });

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  describe('POST /api/auth/logout', () => {
    it('revokes the presented refresh token', async () => {
      const { email, user } = await seedUser();

      const login = await request(server(app))
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });
      const refresh = readCookie(login.headers['set-cookie'], 'refresh_token')!;

      await request(server(app))
        .post('/api/auth/logout')
        .set('Cookie', `refresh_token=${refresh}`)
        .expect(204);

      const live = await db().refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      });
      expect(live).toBe(0);
    });

    it('succeeds even with no session, so a double logout is harmless', async () => {
      await request(server(app)).post('/api/auth/logout').expect(204);
    });
  });
});
