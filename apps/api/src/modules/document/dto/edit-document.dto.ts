import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class EditDocumentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  /**
   * Editor JSON — the same shape the generator writes and the PDF and DOCX
   * renderers read, so an edited document exports through exactly the path a
   * generated one does.
   *
   * Validated as an object and no further. The renderers already treat every
   * node defensively (`DocumentBody` renders unknown node types as text rather
   * than dropping them), and a strict schema here would reject documents
   * written by a newer editor build — which is a worse failure than rendering
   * one unstyled.
   */
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  /**
   * The revision the editor was showing.
   *
   * Not optional. Making it optional would mean an old client silently
   * overwrites a colleague's save, which is the exact failure the field exists
   * to prevent.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}
