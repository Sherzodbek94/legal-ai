import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { OcrStatus } from '@legaltech/database';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class SearchQueryDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  q!: string;

  /**
   * Which retrievers to run. `hybrid` is the default and the point of the module;
   * the single-retriever modes exist for comparing them when tuning.
   */
  @IsOptional()
  @IsIn(['hybrid', 'lexical', 'semantic'])
  mode?: 'hybrid' | 'lexical' | 'semantic';

  /** Restricts the search to one document. */
  @IsOptional()
  @IsString()
  documentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /**
   * Fusion weights.
   *
   * Exposed because the right balance is language-dependent: the lexical half is
   * weaker on this corpus than usual — `simple` configuration does no stemming,
   * so a morphological variant simply does not match — which argues for
   * weighting semantic higher on Uzbek queries. Defaults stay neutral.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  lexicalWeight?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  semanticWeight?: number;
}

export class ListDocumentsQuery {
  @IsOptional()
  @IsEnum(OcrStatus)
  status?: OcrStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}
