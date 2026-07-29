import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService, type RefreshTokenContext } from './services/token.service';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import type { LoginDto, RegisterDto } from './dto/auth.dto';

const BCRYPT_ROUNDS = 12;

/**
 * A bcrypt hash of a throwaway value. Comparing against this when no user
 * exists keeps login timing roughly constant, so the endpoint does not become
 * an account-enumeration oracle.
 */
const DUMMY_HASH = bcrypt.hashSync('unused-placeholder-value', BCRYPT_ROUNDS);

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

    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const membership = user.memberships[0];
    return this.tokens.issueTokens(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        companyId: membership?.companyId,
        companyRole: membership?.role,
      },
      context,
    );
  }

  /** Finds or provisions a user for a verified external identity. */
  async loginWithVerifiedIdentity(
    email: string,
    profile: { name?: string; phoneVerified?: boolean },
    context: RefreshTokenContext = {},
  ) {
    const normalized = email.trim().toLowerCase();

    const user = await this.prisma.client.user.upsert({
      where: { email: normalized },
      update: {
        lastLoginAt: new Date(),
        ...(profile.phoneVerified ? { emailVerified: new Date() } : {}),
      },
      create: {
        email: normalized,
        name: profile.name,
        // No password: this account authenticates through the external
        // provider only, and a null hash can never satisfy bcrypt.compare.
        passwordHash: null,
        emailVerified: new Date(),
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
    return this.tokens.issueTokens(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        companyId: membership?.companyId,
        companyRole: membership?.role,
      },
      context,
    );
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
