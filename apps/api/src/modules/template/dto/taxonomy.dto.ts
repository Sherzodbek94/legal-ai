import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { TemplateCategoryKind } from '@legaltech/database';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateCategoryDto {
  @trim()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric segments separated by hyphens',
  })
  slug!: string;

  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(200)
  nameRu?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(200)
  nameUz?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** Omit to create a new root, in which case `kind` is required. */
  @IsOptional()
  @IsString()
  parentId?: string;

  // A child inherits its parent's branch, so `kind` is meaningful only at a
  // root — and there it is mandatory.
  @ValidateIf((dto: CreateCategoryDto) => !dto.parentId)
  @IsEnum(TemplateCategoryKind)
  kind?: TemplateCategoryKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/** Structure is changed through `move`, so slug, parent, and kind are not here. */
export class UpdateCategoryDto {
  @IsOptional()
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(200)
  nameRu?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(200)
  nameUz?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class MoveCategoryDto {
  /** Null re-parents the category to a root position. */
  @IsOptional()
  @IsString()
  parentId?: string | null;
}

export class TaxonomyTreeQuery {
  @IsOptional()
  @IsEnum(TemplateCategoryKind)
  kind?: TemplateCategoryKind;
}
