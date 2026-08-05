import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CompanyMemberRole } from '@legaltech/database';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class InviteMemberDto {
  @trim()
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(254)
  email!: string;

  /**
   * OWNER is rejected in the service rather than excluded from the enum here,
   * so the refusal carries an explanation instead of a bare "must be a valid
   * enum value".
   */
  @IsEnum(CompanyMemberRole)
  role!: CompanyMemberRole;
}

export class ChangeMemberRoleDto {
  @IsEnum(CompanyMemberRole)
  role!: CompanyMemberRole;
}

export class AcceptInvitationDto {
  /**
   * Required only when the invited address has no account yet — the service
   * decides, because only it knows whether the user exists.
   */
  @IsOptional()
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(72, { message: 'Password must be at most 72 characters' })
  password?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(120)
  name?: string;
}
