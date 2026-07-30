import { IsOptional, IsString } from 'class-validator';

/**
 * A CLICK callback.
 *
 * Every field is typed as a string and validated loosely on purpose. CLICK
 * posts `application/x-www-form-urlencoded`, so everything arrives as text, and
 * the signature is computed over those exact strings — coercing `amount` to a
 * number here would change the bytes the digest is built from and fail every
 * verification.
 *
 * Unknown fields are stripped by the global ValidationPipe's `whitelist`, which
 * is why `sign_string` and the rest are declared even though only the service
 * reads them.
 */
export class ClickCallbackDto {
  @IsString()
  click_trans_id!: string;

  @IsString()
  service_id!: string;

  @IsOptional()
  @IsString()
  click_paydoc_id?: string;

  /** Our order id. */
  @IsString()
  merchant_trans_id!: string;

  /** Echoed back from the Prepare response on Complete. */
  @IsOptional()
  @IsString()
  merchant_prepare_id?: string;

  /** Decimal string, e.g. "49.00". Never parsed before signature verification. */
  @IsString()
  amount!: string;

  /** 0 = Prepare, 1 = Complete. */
  @IsString()
  action!: string;

  /** Negative when the payment failed on CLICK's side. */
  @IsOptional()
  @IsString()
  error?: string;

  @IsOptional()
  @IsString()
  error_note?: string;

  @IsString()
  sign_time!: string;

  @IsString()
  sign_string!: string;
}
