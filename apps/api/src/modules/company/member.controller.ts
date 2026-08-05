import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MemberService } from './services/member.service';
import {
  AcceptInvitationDto,
  ChangeMemberRoleDto,
  InviteMemberDto,
} from './dto/member.dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { NoImpersonation } from '../admin/impersonation/no-impersonation.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

/**
 * Company membership.
 *
 * Every authenticated route derives the tenant from the session rather than a
 * path parameter — the same rule the rest of this module follows after an
 * IDOR where `:id` was trusted for the asset endpoints.
 */
@Controller('companies/members')
export class MemberController {
  constructor(private readonly members: MemberService) {}

  /** Anyone in the company can see who else is in it. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.members.list(user.companyId!);
  }

  /**
   * Blocked during impersonation: adding a person to a customer's workspace
   * is exactly the kind of standing change support must not be able to make
   * on their behalf, and one the customer would have no way to attribute.
   */
  @Roles('OWNER', 'ADMIN')
  @NoImpersonation('auth:credentials')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  invite(@CurrentUser() user: AuthenticatedUser, @Body() dto: InviteMemberDto) {
    return this.members.invite(user.companyId!, dto.email, dto.role, user);
  }

  @Roles('OWNER', 'ADMIN')
  @NoImpersonation('auth:credentials')
  @Delete('invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invitationId') invitationId: string,
  ) {
    return this.members.revokeInvitation(user.companyId!, invitationId);
  }

  @Roles('OWNER', 'ADMIN')
  @NoImpersonation('auth:credentials')
  @Patch(':memberId')
  changeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: ChangeMemberRoleDto,
  ) {
    return this.members.changeRole(user.companyId!, memberId, dto.role, user);
  }

  @Roles('OWNER', 'ADMIN')
  @NoImpersonation('auth:credentials')
  @Delete(':memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
  ) {
    return this.members.remove(user.companyId!, memberId, user);
  }
}

/**
 * Invitation acceptance — public by necessity.
 *
 * The invitee has no session, and in the common case no account at all. The
 * token in the URL is the only credential, which is why it is 32 random bytes
 * and stored only as a hash.
 */
@Controller('invitations')
export class InvitationController {
  constructor(private readonly members: MemberService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  preview(@Param('token') token: string) {
    return this.members.previewInvitation(token);
  }

  @Public()
  // Tight: this endpoint creates accounts.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
  ) {
    const result = await this.members.acceptInvitation(token, dto.password, dto.name);
    // Deliberately does not mint a session. The invitee signs in afterwards,
    // which keeps one path into an authenticated session rather than two.
    return { status: 'joined', companyId: result.companyId, role: result.role };
  }
}
