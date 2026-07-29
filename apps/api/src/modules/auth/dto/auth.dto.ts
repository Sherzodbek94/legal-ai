import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(254)
  email!: string;

  // Length is the dominant factor in password strength; an upper bound is
  // still needed because bcrypt silently truncates beyond 72 bytes.
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(72, { message: 'Password must be at most 72 characters' })
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password!: string;
}

export class RequestOtpDto {
  @IsString()
  @Matches(/^\+?\d{9,15}$/, {
    message: 'Phone must be 9-15 digits, optionally prefixed with +',
  })
  phone!: string;
}

export class VerifyOtpDto {
  @IsString()
  @Matches(/^\+?\d{9,15}$/)
  phone!: string;

  @IsString()
  @Length(4, 8)
  @Matches(/^\d+$/, { message: 'Code must be numeric' })
  code!: string;
}

export class OneIdCallbackDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  state!: string;
}
