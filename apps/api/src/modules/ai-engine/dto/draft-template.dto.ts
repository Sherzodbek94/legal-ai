import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class DraftTemplateDto {
  /** e.g. "tovar yetkazib berish shartnomasi", "mehnat shartnomasi". */
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  documentType!: string;

  @IsOptional()
  @IsIn(['uz-Latn', 'uz-Cyrl', 'ru'])
  language?: string;

  /** Free-text requirements — what this template has to cover. */
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /**
   * Clauses the requester insists on.
   *
   * Bounded: each entry is interpolated into a prompt, and an unbounded list is
   * an unbounded prompt — which costs real money per call and is the cheapest
   * way to turn a form field into a bill.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  mustInclude?: string[];
}
