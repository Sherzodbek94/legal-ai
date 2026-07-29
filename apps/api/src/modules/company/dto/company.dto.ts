import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  IsBankAccount,
  IsMfo,
  IsOked,
  IsStir,
} from '../validators/uz-identifiers';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateCompanyDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @trim()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric segments separated by hyphens',
  })
  slug!: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(300)
  legalName?: string;

  // --- Registry identifiers -------------------------------------------------

  @IsOptional()
  @IsStir()
  stir?: string;

  @IsOptional()
  @IsOked()
  oked?: string;

  @IsOptional()
  @IsMfo()
  mfo?: string;

  @IsOptional()
  @IsBankAccount()
  bankAccount?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(200)
  bankName?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(50)
  vatCode?: string;

  // --- Contact and representation -------------------------------------------

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(500)
  legalAddress?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(500)
  actualAddress?: string;

  @IsOptional()
  @trim()
  @IsString()
  @Matches(/^\+?\d{7,15}$/, {
    message: 'Phone must be 7-15 digits, optionally prefixed with +',
  })
  phone?: string;

  @IsOptional()
  @trim()
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @trim()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(300)
  website?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(200)
  directorName?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(120)
  directorPosition?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(200)
  accountantName?: string;
}

/** Every field optional; `slug` and `stir` remain uniqueness-checked on write. */
export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {}
