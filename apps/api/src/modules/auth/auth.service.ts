import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TokenService,
  type IssuedTokens,
  type RefreshTokenContext,
} from './services/token.service';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import type { LoginDto, RegisterDto } from './dto/auth.dto';

const BCRYPT_ROUNDS = 12;

/**
 * A bcrypt hash of a throwaway value. Comparing against this when no user
 * exists keeps login timing roughly constant, so the endpoint does not become
 * an account-enumeration oracle.
 */
const DUMMY_HASH = bcrypt.hashSync('unused-placeholder-value', BCRYPT_ROUNDS);

/**
 * What every externally-verified sign-in returns.
 *
 * `hasCompany` is carried rather than re-derived: each provider callback uses
 * it to choose between the dashboard and company onboarding, and reading it
 * back out of a JWT it just minted would be indirection for nothing.
 */
export interface IdentityLogin {
  tokens: IssuedTokens;
  userId: string;
  hasCompany: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async register(dto: RegisterDto, context: RefreshTokenContext = {}) {
    const email = dto.email.trim().toLowerCase();

    const existing = await this.prisma.client.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      // Registration cannot avoid disclosing that an address is taken, so the
      // mitigation belongs in rate limiting rather than a vague message.
      throw new ConflictException('An account with that email already exists');
    }

    const user = await this.prisma.client.user.create({
      data: {
        email,
        name: dto.name,
        passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
      },
    });

    return this.issueFor(user.id, email, user.role, context);
  }

  async login(dto: LoginDto, context: RefreshTokenContext = {}) {
    const email = dto.email.trim().toLowerCase();

    const user = await this.prisma.client.user.findFirst({
      where: { email, deletedAt: null },
      include: {
        memberships: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });

    // Always run a comparison, even with no user, so response time does not
    // reveal whether the address is registered.
    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_HASH,
    );

    if (!user || !user.passwordHash || !passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    /**
     * A suspended account is refused at the door.
     *
     * `JwtStrategy` re-checks `lockedAt` on every request, so a locked user
     * could never actually *do* anything — but login itself did not check, and
     * so happily answered 200, wrote a `lastLoginAt`, and persisted a refresh
     * token row for an account an operator had already suspended. The session
     * was inert and the audit trail said otherwise.
     *
     * Checked after the password comparison, deliberately. Checking first
     * would answer differently for a locked account before verifying the
     * password at all, turning the endpoint into an oracle for which accounts
     * are suspended. Past this line the caller has already proven they know
     * the password, so naming the reason costs nothing and saves them from
     * retrying a password that was never the problem.
     */
    if (user.lockedAt) {
      throw new ForbiddenException(
        user.lockedReason
          ? `This account is suspended: ${user.lockedReason}`
          : 'This account is suspended. Contact your administrator.',
      );
    }

    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const membership = user.memberships[0];
    return this.tokens.issueTokens(
      {
        sub: user.id,
        email: user.email ?? undefined,
        role: user.role,
        companyId: membership?.companyId,
        companyRole: membership?.role,
      },
      context,
    );
  }

  /**
   * Finds or provisions a user for a verified external identity.
   *
   * `subject` is the provider's own identifier for the person (e.g. OneID's
   * `user_id`/PINFL) — stable in a way email is not. An email collision
   * between a password-based account and a different citizen's OneID profile
   * must never authenticate as the existing account, so the first successful
   * login binds `subject` to that user, and every later login must match it.
   * A pre-existing account that has never signed in through this provider is
   * refused rather than silently annexed.
   */
  async loginWithVerifiedIdentity(
    email: string,
    subject: string,
    profile: { name?: string; phoneVerified?: boolean },
    context: RefreshTokenContext = {},
  ) {
    const normalized = email.trim().toLowerCase();

    const existing = await this.prisma.client.user.findUnique({
      where: { email: normalized },
      select: { id: true, oneIdSubject: true },
    });

    if (existing && existing.oneIdSubject && existing.oneIdSubject !== subject) {
      // Someone else's OneID identity, coincidentally sharing this email.
      throw new UnauthorizedException(
        'This account is bound to a different OneID identity',
      );
    }

    if (existing && !existing.oneIdSubject) {
      // A password-based (or otherwise unbound) account with this email
      // already exists. Binding it to whichever OneID subject shows up first
      // would let anyone who merely knows the email claim it — refuse instead.
      throw new UnauthorizedException(
        'An account with this email already exists; sign in with a password first and link OneID from account settings',
      );
    }

    const user = await this.prisma.client.user.upsert({
      where: { email: normalized },
      update: {
        lastLoginAt: new Date(),
        oneIdSubject: subject,
        ...(profile.phoneVerified ? { emailVerified: new Date() } : {}),
      },
      create: {
        email: normalized,
        name: profile.name,
        // No password: this account authenticates through the external
        // provider only, and a null hash can never satisfy bcrypt.compare.
        passwordHash: null,
        emailVerified: new Date(),
        oneIdSubject: subject,
      },
      include: {
        memberships: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });

    const membership = user.memberships[0];
    const tokens = await this.tokens.issueTokens(
      {
        sub: user.id,
        email: user.email ?? undefined,
        role: user.role,
        companyId: membership?.companyId,
        companyRole: membership?.role,
      },
      context,
    );

    // Told to the caller rather than inferred from the tokens: the OneID
    // callback uses this to decide whether the browser lands on the
    // dashboard or on company onboarding, and re-deriving either from a
    // signed JWT it just received is more indirection than they're worth.
    return { tokens, userId: user.id, hasCompany: Boolean(membership) };
  }

  /**
   * Signs in — or provisions — the account behind a verified phone number.
   *
   * Called only after `OtpService.verifyOtp` has confirmed possession of the
   * number, which is why there is no password here: the SMS *is* the proof.
   *
   * Provisioning on first use is deliberate. Phone-first signup is the normal
   * path in this market, and requiring an email address before a user can
   * receive their own code would put a form in front of the simplest way in.
   * The account is created with no password, exactly like a OneID one, so a
   * null hash can never satisfy `bcrypt.compare`.
   */
  async loginWithVerifiedPhone(
    phone: string,
    context: RefreshTokenContext = {},
  ): Promise<IdentityLogin> {
    const now = new Date();

    const user = await this.prisma.client.user.upsert({
      where: { phone },
      update: { lastLoginAt: now, phoneVerified: now },
      create: {
        phone,
        phoneVerified: now,
        // No email yet. It is nullable on purpose for this path — the address
        // is collected later, if a flow actually needs one.
        email: null,
        passwordHash: null,
      },
      include: {
        memberships: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });

    if (user.lockedAt) {
      throw new ForbiddenException(
        user.lockedReason
          ? `This account is suspended: ${user.lockedReason}`
          : 'This account is suspended. Contact your administrator.',
      );
    }

    const membership = user.memberships[0];
    const tokens = await this.tokens.issueTokens(
      {
        sub: user.id,
        email: user.email ?? undefined,
        role: user.role,
        companyId: membership?.companyId,
        companyRole: membership?.role,
      },
      context,
    );

    return { tokens, userId: user.id, hasCompany: Boolean(membership) };
  }

  /**
   * Signs in — or provisions — the account behind a verified Google identity.
   *
   * Binds Google's `sub` claim rather than trusting the email, the same rule
   * `oneIdSubject` follows: a Google account can change its address, and a
   * released address can be reassigned to someone else. Matching on email
   * alone would eventually hand one person another's workspace.
   */
  async loginWithGoogle(
    profile: { subject: string; email: string; name?: string; emailVerified: boolean },
    context: RefreshTokenContext = {},
  ): Promise<IdentityLogin> {
    const email = profile.email.trim().toLowerCase();

    if (!profile.emailVerified) {
      // Google will happily return an unverified address on some workspace
      // configurations; treating it as proof of the address would let anyone
      // who can create such an account claim a matching one here.
      throw new UnauthorizedException(
        'This Google account has no verified email address',
      );
    }

    const bySubject = await this.prisma.client.user.findUnique({
      where: { googleSubject: profile.subject },
      select: { id: true },
    });

    if (!bySubject) {
      const byEmail = await this.prisma.client.user.findUnique({
        where: { email },
        select: { id: true, googleSubject: true },
      });

      if (byEmail?.googleSubject && byEmail.googleSubject !== profile.subject) {
        throw new UnauthorizedException(
          'This account is bound to a different Google identity',
        );
      }
      if (byEmail) {
        // A pre-existing password or OneID account. Linking it to whichever
        // Google identity presents the same address first is exactly the
        // takeover this guards against.
        throw new UnauthorizedException(
          'An account with this email already exists; sign in with your existing method first',
        );
      }
    }

    const now = new Date();
    const user = await this.prisma.client.user.upsert({
      where: bySubject ? { id: bySubject.id } : { email },
      update: { lastLoginAt: now, googleSubject: profile.subject },
      create: {
        email,
        name: profile.name,
        passwordHash: null,
        emailVerified: now,
        googleSubject: profile.subject,
      },
      include: {
        memberships: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });

    if (user.lockedAt) {
      throw new ForbiddenException(
        user.lockedReason
          ? `This account is suspended: ${user.lockedReason}`
          : 'This account is suspended. Contact your administrator.',
      );
    }

    const membership = user.memberships[0];
    const tokens = await this.tokens.issueTokens(
      {
        sub: user.id,
        email: user.email ?? undefined,
        role: user.role,
        companyId: membership?.companyId,
        companyRole: membership?.role,
      },
      context,
    );

    return { tokens, userId: user.id, hasCompany: Boolean(membership) };
  }

  private async issueFor(
    userId: string,
    email: string,
    role: JwtPayload['role'],
    context: RefreshTokenContext,
  ) {
    return this.tokens.issueTokens({ sub: userId, email, role }, context);
  }

  async logout(refreshToken?: string) {
    if (refreshToken) {
      await this.tokens.revokeRefreshToken(refreshToken);
    }
  }

  async logoutAll(userId: string) {
    await this.tokens.revokeAllForUser(userId);
  }
}
