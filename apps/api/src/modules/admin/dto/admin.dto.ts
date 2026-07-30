import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AuditAction } from '@legaltech/database';
import { MIN_REASON_LENGTH } from '../impersonation/impersonation-policy';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** Query params arrive as strings; the global pipe does not coerce implicitly. */
const toOptionalBoolean = () =>
  Transform(({ value }) => {
    if (value === undefined || value === '') return undefined;
    return value === true || value === 'true';
  });

export class ListQuery {
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(100)
  search?: string;

  /** Omit for all, true for locked only, false for unlocked only. */
  @IsOptional()
  @toOptionalBoolean()
  @IsBoolean()
  locked?: boolean;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}

export class LockDto {
  /**
   * Why the account is being suspended.
   *
   * Required, and stored on the record. A lock with no stated reason is
   * indefensible when the customer asks — and when a reviewer asks six months
   * later, nobody remembers.
   */
  @trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message: 'A reason of at least 10 characters is required',
  })
  @MaxLength(1000)
  reason!: string;
}

export class AuditQuery {
  @IsOptional()
  @IsString()
  companyId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(60)
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

export class StartImpersonationDto {
  @IsString()
  @IsNotEmpty()
  targetUserId!: string;

  /** Recorded on the session and in the audit log. */
  @trim()
  @IsString()
  @MinLength(MIN_REASON_LENGTH, {
    message: `A justification of at least ${MIN_REASON_LENGTH} characters is required`,
  })
  @MaxLength(1000)
  reason!: string;
}

export class CostWindowQuery {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}
