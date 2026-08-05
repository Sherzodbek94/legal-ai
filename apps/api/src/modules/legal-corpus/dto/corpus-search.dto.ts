import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
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

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** Query-string booleans arrive as the strings `'true'` / `'false'`. */
const toBoolean = () =>
  Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  });

export class CorpusSearchDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  q!: string;

  /** See `SearchQueryDto`: single-retriever modes exist for tuning. */
  @IsOptional()
  @IsIn(['hybrid', 'lexical', 'semantic'])
  mode?: 'hybrid' | 'lexical' | 'semantic';

  /**
   * Restricts results to one official text.
   *
   * `uz-Latn`, `uz-Cyrl`, `ru`. Worth filtering on: the same act exists in all
   * three, and an unfiltered search returns the same provision three times in
   * alphabets the reader may not want.
   */
  @IsOptional()
  @IsIn(['uz-Latn', 'uz-Cyrl', 'ru'])
  language?: string;

  /**
   * Excludes acts not recorded as in force.
   *
   * Off by default. A repealed provision is often exactly what someone
   * researching a historic contract needs, and every hit carries `superseded`
   * so the caller can tell — the failure to prevent is citing one unknowingly,
   * not seeing one at all.
   */
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  inForceOnly?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

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
