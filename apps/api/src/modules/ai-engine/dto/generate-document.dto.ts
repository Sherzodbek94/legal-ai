import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { LegalLocale } from '../providers/llm-provider.interface';

export class GenerateDocumentDto {
  @IsIn(['uz-Latn', 'uz-Cyrl', 'ru'], {
    message: 'locale must be one of: uz-Latn, uz-Cyrl, ru',
  })
  locale!: LegalLocale;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  documentType!: string;

  /**
   * Prompt variables, typically from `mapCompanyToVariables`. Values are
   * already sanitized there; the engine additionally wraps them in explicit
   * data delimiters before they reach the model.
   */
  @IsObject()
  variables!: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instructions?: string;
}
