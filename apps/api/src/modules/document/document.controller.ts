import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { DocumentService } from './document.service';
import { DocumentExportService } from './generator/document-export.service';
import { ExportDocumentQuery } from './dto/export.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import type { ExportFormat } from './generator/render-model';

@Controller('documents')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly exports: DocumentExportService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    // Scoped to the caller's tenant rather than a query parameter: a companyId
    // supplied by the client is a request to read someone else's documents.
    return this.documentService.findAll(user.companyId!);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    // Tenant is passed explicitly. Without it this endpoint returned any
    // company's document by id.
    return this.documentService.findOne(id, user.companyId!);
  }

  /**
   * Streams a rendered copy.
   *
   * Rendering runs Chromium (PDF) or builds a zip (DOCX), both far more
   * expensive than a normal request, so this is throttled well below the global
   * default.
   */
  @Roles('OWNER', 'ADMIN', 'ATTORNEY', 'PARALEGAL')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':id/export/:format')
  @Header('Cache-Control', 'no-store')
  async export(
    @Param('id') id: string,
    @Param('format') format: string,
    @Query() query: ExportDocumentQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const requested: ExportFormat = format === 'docx' ? 'docx' : 'pdf';

    const { stream, filename, contentType } = await this.exports.export(
      id,
      requested,
      query,
      user,
    );

    res.setHeader('Content-Type', contentType);
    // The filename is already stripped to word characters by the export
    // service, so it cannot break out of the header.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );

    // If the client hangs up mid-download, tear the render down rather than
    // leaving a Chromium page open until it times out.
    res.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });

    stream.pipe(res);
  }
}
