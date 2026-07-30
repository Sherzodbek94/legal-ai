import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { NotificationChannel } from '@legaltech/database';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

const toOptionalBoolean = () =>
  Transform(({ value }) => {
    if (value === undefined || value === '') return undefined;
    return value === true || value === 'true';
  });

export class ListNotificationsQuery {
  @IsOptional()
  @toOptionalBoolean()
  @IsBoolean()
  unreadOnly?: boolean;

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

export class UpdatePreferencesDto {
  /**
   * Channels the user accepts.
   *
   * IN_APP may be submitted and is ignored — it is the user's own inbox, and there
   * is nothing to opt out of.
   */
  @IsOptional()
  @IsArray()
  @IsEnum(NotificationChannel, { each: true })
  enabledChannels?: NotificationChannel[];

  /** Overrides the account email. Null clears the override. */
  @IsOptional()
  @trim()
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(254)
  email?: string | null;

  /** Uzbekistan mobile number; normalised and validated on save. */
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  /**
   * Local hour quiet hours begin, 0–23.
   *
   * Both ends are required together — see PreferenceService.update. 22 to 8 wraps
   * midnight and is the normal configuration.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  quietHoursStart?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  quietHoursEnd?: number | null;

  /** IANA zone name; validated against Intl on save. */
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
