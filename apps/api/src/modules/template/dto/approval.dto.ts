import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class SubmitForApprovalDto {
  /** Context for the approvers; recorded on the audit entry. */
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class DecideApprovalDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  /**
   * Required in practice for a rejection — the drafter needs to know what to
   * fix — but not enforced here: a blank rejection comment is a process
   * problem, and blocking the decision on it just moves the rejection offline.
   */
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
