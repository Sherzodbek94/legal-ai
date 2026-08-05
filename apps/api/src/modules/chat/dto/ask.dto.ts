import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class AskDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  // Bounded because it reaches a prompt: an unbounded question is an unbounded
  // bill, and no legal question needs four thousand characters.
  @MaxLength(4000)
  question!: string;

  /** Continues an existing thread; omit to start one. */
  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsIn(['uz-Latn', 'uz-Cyrl', 'ru'])
  language?: string;

  /**
   * Search this company's own scans as well as the statute book.
   *
   * On by default: "can I terminate under this contract" wants the law and the
   * contract in one answer. Off is for a pure research question, where a
   * matching scan is noise that displaces a statute from the source list.
   */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeOwnDocuments?: boolean;
}
