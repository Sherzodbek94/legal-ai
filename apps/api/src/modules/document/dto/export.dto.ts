import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** Query strings arrive as text; the global pipe does not coerce implicitly. */
const toBoolean = () =>
  Transform(({ value }) => value === true || value === 'true');

export class ExportDocumentQuery {
  /**
   * Overrides the watermark text. It cannot switch the watermark *off* for an
   * unapproved document — see DocumentExportService.resolveWatermark.
   */
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(40)
  watermark?: string;

  /**
   * Embeds the company seal and signature. Rejected unless the document has
   * completed its approval chain.
   */
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  applySeal?: boolean;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(200)
  counterpartyName?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(120)
  counterpartyPosition?: string;
}
