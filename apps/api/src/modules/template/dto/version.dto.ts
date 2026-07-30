import { Transform } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateVersionDto {
  /** TipTap document node; see CreateTemplateDto.content. */
  @IsObject()
  content!: Record<string, unknown>;

  /** Validated by `parseVariableSchema` before the draft is written. */
  @IsObject()
  variableSchema!: Record<string, unknown>;

  /** Defaults to the chain for the template's taxonomy branch. */
  @IsOptional()
  @IsArray()
  approvalChain?: unknown[];

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(500)
  changeNote?: string;
}

export class PublishVersionDto {
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(500)
  changeNote?: string;
}

export class RollbackDto {
  /** The archived version to copy forward. */
  @IsString()
  @IsNotEmpty()
  versionId!: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(500)
  changeNote?: string;
}

/** Values to check against a version's variable schema without generating. */
export class ValidateVariablesDto {
  @IsObject()
  values!: Record<string, unknown>;
}
