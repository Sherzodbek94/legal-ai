import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApprovalService } from './services/approval.service';
import { DecideApprovalDto, SubmitForApprovalDto } from './dto/approval.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

/**
 * Document approval workflow: DRAFT -> PENDING_APPROVAL -> COMPLETED.
 *
 * Route-level @Roles is coarse — it keeps VIEWERs out. Which *specific* step a
 * caller may decide depends on the chain stored on the document, so the real
 * authorisation happens in ApprovalService against that chain, not here.
 */
@Controller('documents')
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  /** Documents whose current step is waiting on the caller. */
  @Roles('OWNER', 'ADMIN', 'ATTORNEY')
  @Get('approvals/queue')
  queue(@CurrentUser() user: AuthenticatedUser) {
    return this.approvals.listMyQueue(user);
  }

  @Get(':id/approvals')
  state(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.approvals.getApprovalState(id, user.companyId!);
  }

  @Roles('OWNER', 'ADMIN', 'ATTORNEY', 'PARALEGAL')
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SubmitForApprovalDto,
  ) {
    return this.approvals.submitForApproval(id, dto, user);
  }

  @Roles('OWNER', 'ADMIN', 'ATTORNEY')
  @Post(':id/approvals/decide')
  @HttpCode(HttpStatus.OK)
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideApprovalDto,
  ) {
    return this.approvals.decide(id, dto, user);
  }

  @Roles('OWNER', 'ADMIN', 'ATTORNEY', 'PARALEGAL')
  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.approvals.withdraw(id, user);
  }

  @Roles('OWNER', 'ADMIN', 'ATTORNEY', 'PARALEGAL')
  @Post(':id/revise')
  @HttpCode(HttpStatus.OK)
  revise(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.approvals.reviseAfterRejection(id, user);
  }
}
