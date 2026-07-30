import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UzumCallbackDto {
  @IsIn(['check', 'create', 'confirm', 'reverse'])
  operation!: 'check' | 'create' | 'confirm' | 'reverse';

  @IsString()
  transactionId!: string;

  /** Our order id. */
  @IsString()
  orderId!: string;

  /** Minor units (tiyin). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount!: number;

  @IsString()
  signature!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  reason?: number;
}
