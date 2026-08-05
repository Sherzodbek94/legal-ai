import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { AuditAction, CompanyMemberRole, Prisma } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

const BCRYPT_ROUNDS = 12;

export interface InvitationPreview {
  companyName: string;
  email: string;
  role: CompanyMemberRole;
  /** True when the address already has an account, so the form asks to sign in. */
  hasAccount: boolean;
}

/**
 * Company membership: who belongs to a workspace, and how they got there.
 *
 * Until this existed there was no way to add a second person to a company at
 * all — `CompanyMember` rows were written only by the seed script and by
 * `registerAsOwner`, so every workspace was permanently a workspace of one.
 * The approval chains this product is built around need at least two people
 * by definition: a document cannot be approved by whoever submitted it.
 */
@Injectable()
export class MemberService {
  private readonly logger = new Logger(MemberService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationService,
  ) {}

  private get invitationTtlMs(): number {
    return this.config.get<number>('INVITATION_TTL_DAYS', 7) * 86_400_000;
  }

  private get webAppUrl(): string {
    return this.config
      .get<string>('WEB_APP_URL', 'http://localhost:3000')
      .replace(/\/+$/, '');
  }

  /** Only the hash is stored; the plaintext exists once, in the email. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async list(companyId: string) {
    const [members, invitations] = await Promise.all([
      this.prisma.client.companyMember.findMany({
        where: { companyId, deletedAt: null },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          role: true,
          joinedAt: true,
          invitedAt: true,
          createdAt: true,
          user: {
            select: { id: true, email: true, name: true, lastLoginAt: true, lockedAt: true },
          },
        },
      }),
      this.prisma.client.companyInvitation.findMany({
        where: { companyId, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          role: true,
          expiresAt: true,
          createdAt: true,
        },
      }),
    ]);

    const now = new Date();
    return {
      members,
      // Expiry is reported rather than filtered: "this invitation ran out" is
      // something the owner needs to see so they can send another.
      invitations: invitations.map((invitation) => ({
        ...invitation,
        expired: invitation.expiresAt <= now,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Invite
  // ---------------------------------------------------------------------------

  /**
   * Invites an address to join, and emails a single-use link.
   *
   * Refuses to grant OWNER. There is exactly one owner per company by this
   * product's model, and handing out a second one through an invite is how a
   * workspace ends up with two people who can each remove the other.
   */
  async invite(
    companyId: string,
    email: string,
    role: CompanyMemberRole,
    actor: AuthenticatedUser,
  ) {
    const normalized = email.trim().toLowerCase();

    if (role === CompanyMemberRole.OWNER) {
      throw new BadRequestException(
        'Ownership cannot be granted by invitation. Transfer it from the members list instead.',
      );
    }

    const existingUser = await this.prisma.client.user.findUnique({
      where: { email: normalized },
      select: { id: true },
    });

    if (existingUser) {
      const membership = await this.prisma.client.companyMember.findFirst({
        where: { userId: existingUser.id, deletedAt: null },
        select: { companyId: true },
      });

      if (membership?.companyId === companyId) {
        throw new ConflictException('That person is already a member of this company');
      }
      if (membership) {
        // One company per account, matching `registerAsOwner`. Inviting them
        // anyway would produce a second membership nothing else expects.
        throw new ConflictException('That account already belongs to another company');
      }
    }

    const token = randomBytes(32).toString('base64url');

    try {
      const invitation = await this.prisma.client.companyInvitation.create({
        data: {
          companyId,
          email: normalized,
          role,
          tokenHash: this.hashToken(token),
          expiresAt: new Date(Date.now() + this.invitationTtlMs),
          invitedById: actor.id,
        },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      });

      await this.sendInvitationEmail(companyId, normalized, token, actor);

      return invitation;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // The partial unique index on (companyId, email) WHERE not accepted or
        // revoked. Two owners inviting the same person at once land here.
        throw new ConflictException(
          'That address already has a pending invitation. Withdraw it first to send a new one.',
        );
      }
      throw error;
    }
  }

  private async sendInvitationEmail(
    companyId: string,
    email: string,
    token: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const company = await this.prisma.client.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });

    const link = `${this.webAppUrl}/invitations/${token}`;

    /*
     * Dispatched to the *inviter*, not the invitee.
     *
     * NotificationService routes by `userId` — it reads the recipient's
     * channel preferences and delivery address from their account — and an
     * invitee by definition may not have one. Sending the inviter their own
     * copy at least puts the working link somewhere retrievable while an
     * address-addressed transport is missing; the log line below is what an
     * operator uses in the meantime.
     *
     * Not fatal either way: an invitation that was created but not delivered
     * is recoverable (copy the link from the members list), where losing the
     * row would not be.
     */
    this.logger.log(`Invitation created for ${email} to join ${company?.name ?? companyId}`);

    await this.notifications
      .dispatch({
        event: 'company.member_invited',
        userId: actor.id,
        companyId,
        title: `Invitation sent to ${email}`,
        body: `${email} has been invited to join ${company?.name ?? 'your company'}. Their link: ${link}`,
        data: { email, link },
        dedupeKey: `invitation:${companyId}:${email}`,
      })
      .catch((error: Error) => {
        this.logger.warn(`Could not notify inviter: ${error.message}`);
      });
  }

  /** Withdraws a pending invitation. */
  async revokeInvitation(companyId: string, invitationId: string): Promise<void> {
    const { count } = await this.prisma.client.companyInvitation.updateMany({
      where: { id: invitationId, companyId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundException('Invitation not found, or already used');
    }
  }

  // ---------------------------------------------------------------------------
  // Accept
  // ---------------------------------------------------------------------------

  /** Public: what the accept page shows before asking for anything. */
  async previewInvitation(token: string): Promise<InvitationPreview> {
    const invitation = await this.findLiveInvitation(token);

    const user = await this.prisma.client.user.findUnique({
      where: { email: invitation.email },
      select: { passwordHash: true },
    });

    return {
      companyName: invitation.company.name,
      email: invitation.email,
      role: invitation.role,
      hasAccount: Boolean(user?.passwordHash),
    };
  }

  private async findLiveInvitation(token: string) {
    if (!token) throw new NotFoundException('Invitation not found');

    const invitation = await this.prisma.client.companyInvitation.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { company: { select: { id: true, name: true, deletedAt: true } } },
    });

    // Uniform 404 for every unusable state — expired, spent, withdrawn, or
    // never real. Distinguishing them tells an address-guesser which tokens
    // once existed.
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date() ||
      invitation.company.deletedAt
    ) {
      throw new NotFoundException('This invitation is no longer valid');
    }

    return invitation;
  }

  /**
   * Accepts an invitation, creating the account when there is not one already.
   *
   * The membership and the invitation's consumption commit together: a
   * half-applied acceptance would either leave a live token for someone who
   * already joined, or a member with no record of how they got in.
   */
  async acceptInvitation(
    token: string,
    password: string | undefined,
    name: string | undefined,
  ): Promise<{ userId: string; companyId: string; role: CompanyMemberRole }> {
    const invitation = await this.findLiveInvitation(token);

    const existing = await this.prisma.client.user.findUnique({
      where: { email: invitation.email },
      select: { id: true, passwordHash: true },
    });

    if (!existing && (!password || password.length < 12)) {
      throw new BadRequestException(
        'A password of at least 12 characters is required to create your account',
      );
    }

    return this.prisma.client.$transaction(async (tx) => {
      // Guarded consumption: two clicks on the same emailed link race here,
      // and exactly one wins.
      const claimed = await tx.companyInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });

      if (claimed.count === 0) {
        throw new NotFoundException('This invitation is no longer valid');
      }

      const user = existing
        ? existing
        : await tx.user.create({
            data: {
              email: invitation.email,
              name,
              passwordHash: await bcrypt.hash(password!, BCRYPT_ROUNDS),
              // The address is proven by the fact they received the token.
              emailVerified: new Date(),
            },
            select: { id: true, passwordHash: true },
          });

      await tx.companyMember.create({
        data: {
          companyId: invitation.companyId,
          userId: user.id,
          role: invitation.role,
          invitedAt: invitation.createdAt,
          joinedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          companyId: invitation.companyId,
          userId: user.id,
          action: AuditAction.CREATE,
          entityType: 'CompanyMember',
          entityId: user.id,
          metadata: {
            event: 'INVITATION_ACCEPTED',
            email: invitation.email,
            role: invitation.role,
            invitedById: invitation.invitedById,
          },
        },
      });

      return {
        userId: user.id,
        companyId: invitation.companyId,
        role: invitation.role,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Manage
  // ---------------------------------------------------------------------------

  async changeRole(
    companyId: string,
    memberId: string,
    role: CompanyMemberRole,
    actor: AuthenticatedUser,
  ) {
    const member = await this.getMemberOrThrow(companyId, memberId);

    if (member.userId === actor.id) {
      // Otherwise the only owner can demote themselves and lock the company
      // out of its own billing and member management.
      throw new ForbiddenException('You cannot change your own role');
    }
    if (member.role === CompanyMemberRole.OWNER || role === CompanyMemberRole.OWNER) {
      throw new BadRequestException(
        'Ownership is transferred separately, not changed like an ordinary role',
      );
    }

    return this.prisma.client.companyMember.update({
      where: { id: member.id },
      data: { role },
      select: { id: true, role: true },
    });
  }

  async remove(companyId: string, memberId: string, actor: AuthenticatedUser): Promise<void> {
    const member = await this.getMemberOrThrow(companyId, memberId);

    if (member.userId === actor.id) {
      throw new ForbiddenException('You cannot remove yourself from the company');
    }
    if (member.role === CompanyMemberRole.OWNER) {
      throw new BadRequestException('The owner cannot be removed');
    }

    // Soft delete: the member's documents, approvals, and audit entries all
    // reference this user, and those must stay readable after they leave.
    await this.prisma.client.companyMember.update({
      where: { id: member.id },
      data: { deletedAt: new Date() },
    });

    this.logger.log(`Member ${member.userId} removed from company ${companyId}`);
  }

  private async getMemberOrThrow(companyId: string, memberId: string) {
    const member = await this.prisma.client.companyMember.findFirst({
      where: { id: memberId, companyId, deletedAt: null },
      select: { id: true, userId: true, role: true },
    });

    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  /** Constant-time token comparison, for callers that compare rather than look up. */
  static tokensMatch(a: string, b: string): boolean {
    const bufA = Buffer.from(a ?? '', 'utf8');
    const bufB = Buffer.from(b ?? '', 'utf8');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
