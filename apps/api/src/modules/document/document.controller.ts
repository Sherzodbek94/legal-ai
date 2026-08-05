import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UsageMetric } from '@legaltech/database';
import type { Response } from 'express';
import { DocumentService } from './document.service';
import { DocumentCreationService } from './creation/document-creation.service';
import { DocumentExportService } from './generator/document-export.service';
import { ExportDocumentQuery } from './dto/export.dto';
import { CreateDocumentDto } from './dto/create-document.dto';
import { EditDocumentDto } from './dto/edit-document.dto';
import { DocumentEditService } from './editing/document-edit.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ConsumesQuota } from '../billing/limits/plan-limit.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import type { ExportFormat } from './generator/render-model';

@Controller('documents')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly creation: DocumentCreationService,
    private readonly exports: DocumentExportService,
    private readonly editing: DocumentEditService,
  ) {}

  /**
   * Creates a document from a published template.
   *
   * Metered against DOCUMENTS_GENERATED here rather than on export, so a
   * customer is charged once for producing a document rather than once per time
   * they download it. PlanLimitGuard reserves before the handler runs and
   * QuotaRefundInterceptor releases if it throws, so a failed generation costs
   * nothing.
   *
   * Setting `useAi` additionally consumes AI_GENERATIONS — see
   * DocumentCreationService.
   */
  @Roles('OWNER', 'ADMIN', 'ATTORNEY', 'PARALEGAL')
  @ConsumesQuota(UsageMetric.DOCUMENTS_GENERATED)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  create(
    @Body() dto: CreateDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.creation.create(dto, user);
  }

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
   * Saves an edit.
   *
   * `expectedRevision` is what makes concurrent editing safe rather than
   * last-write-wins; the service answers 409 with the current revision when it
   * does not match. Refused outright while a document is awaiting approval or
   * after it has completed one — see `DocumentEditService.LOCKED`.
   */
  @Roles('OWNER', 'ADMIN', 'ATTORNEY', 'PARALEGAL')
  @Patch(':id')
  edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: EditDocumentDto,
  ) {
    return this.editing.update(id, user.companyId!, user.id, {
      title: dto.title,
      content: dto.content as never,
      expectedRevision: dto.expectedRevision,
    });
  }

  /** Prior states, newest first. Bodies excluded — see the service. */
  @Get(':id/versions')
  versions(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.editing.listVersions(id, user.companyId!);
  }

  /** One past state, with its body, for previewing before a restore. */
  @Get(':id/versions/:versionId')
  version(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.editing.getVersion(id, user.companyId!, versionId);
  }

  /**
   * Restores a past state.
   *
   * An ordinary edit under the covers, so the state being replaced is itself
   * snapshotted — restoring is undoable.
   */
  @Roles('OWNER', 'ADMIN', 'ATTORNEY', 'PARALEGAL')
  @Post(':id/versions/:versionId/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.editing.restore(id, user.companyId!, user.id, versionId);
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
    // NOT `passthrough: true`. In passthrough mode Nest still owns the
    // response and ends it with whatever the handler returns — which here is
    // nothing, so it closed the response before the pipe below had written a
    // byte. The download arrived as HTTP 200, `application/pdf`, and zero
    // bytes: a file that opens as corrupt rather than an error anyone can act
    // on. Manual piping requires full control of the response.
    @Res() res: Response,
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
