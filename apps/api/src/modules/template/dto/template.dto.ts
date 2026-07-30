import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TemplateCategoryKind, TemplateStatus } from '@legaltech/database';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateTemplateDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric segments separated by hyphens',
  })
  slug!: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** Must be a leaf; see TemplateService.resolveCategory. */
  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  /**
   * TipTap document node. Validated as an object only — its internal shape is
   * the editor's contract, and mirroring it here would mean this DTO needs a
   * change every time the editor gains a node type.
   */
  @IsObject()
  content!: Record<string, unknown>;

  /** Defaults to an empty schema; validated by `parseVariableSchema`. */
  @IsOptional()
  @IsObject()
  variableSchema?: Record<string, unknown>;

  /** Defaults to the chain for the category's branch. */
  @IsOptional()
  @IsArray()
  approvalChain?: unknown[];
}

/**
 * The fields a template can be edited in place.
 *
 * Body and variable contract are deliberately absent: changing either means a
 * new version, so that documents already generated keep resolving the text they
 * were generated from.
 */
class TemplateMetadata {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @trim()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric segments separated by hyphens',
  })
  slug!: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class UpdateTemplateDto extends PartialType(TemplateMetadata) {}

export class MoveTemplateDto {
  @IsString()
  @IsNotEmpty()
  categoryId!: string;
}

export class ListTemplatesQuery {
  /** Selects the whole branch beneath this category, not just the node. */
  @IsOptional()
  @IsString()
  categoryId?: string;

  /** Ignored when `categoryId` is supplied — the branch already implies a kind. */
  @IsOptional()
  @IsEnum(TemplateCategoryKind)
  kind?: TemplateCategoryKind;

  @IsOptional()
  @IsEnum(TemplateStatus)
  status?: TemplateStatus;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(100)
  search?: string;

  /** Id of the last row on the previous page. */
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
