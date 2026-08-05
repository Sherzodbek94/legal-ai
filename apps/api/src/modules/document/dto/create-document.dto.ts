import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { LegalLocale } from '../../ai-engine/providers/llm-provider.interface';

export class CreateDocumentDto {
  @IsString()
  @IsNotEmpty()
  templateId!: string;

  /** Defaults to the template's name when omitted. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  /**
   * Values for the template version's declared variables.
   *
   * Not validated field-by-field here — the contract lives on the template
   * version, so `validateVariableValues` checks it against that schema and
   * returns per-field issues. class-validator only confirms it is an object.
   */
  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;

  /**
   * Whether to draft the body with the AI engine instead of filling the
   * template's own text.
   *
   * Defaults to false. Template interpolation is deterministic, free, and
   * produces the text a lawyer already approved, which is the right default for
   * a legal document; the model is opt-in.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  useAi?: boolean;

  /** Extra drafting guidance. Ignored unless `useAi` is set. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instructions?: string;

  @IsOptional()
  @IsIn(['uz-Latn', 'uz-Cyrl', 'ru'], {
    message: 'locale must be one of: uz-Latn, uz-Cyrl, ru',
  })
  locale?: LegalLocale;
}
