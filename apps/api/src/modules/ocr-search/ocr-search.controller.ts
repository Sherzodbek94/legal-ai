import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ParseFilePipeBuilder } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UsageMetric } from '@legaltech/database';
import { OcrService } from './ocr/ocr.service';
import { IndexingService } from './embedding/indexing.service';
import { HybridSearchService } from './search/hybrid-search.service';
import { ListDocumentsQuery, SearchQueryDto } from './dto/search.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ConsumesQuota } from '../billing/limits/plan-limit.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import type { UploadedFileLike } from '../company/services/company-asset.service';

/** Scans are larger than seals; a multi-page contract photograph runs to tens of MB. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@Controller('search')
export class OcrSearchController {
  constructor(
    private readonly ocr: OcrService,
    private readonly indexing: IndexingService,
    private readonly hybrid: HybridSearchService,
  ) {}

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Hybrid search across the tenant's extracted documents.
   *
   * GET so results are linkable and cacheable by the browser's history. The
   * throttle is moderate: each query in hybrid mode costs one embedding call, so
   * an unbounded search box is a way to spend money.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  search(@Query() dto: SearchQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.hybrid.search(dto, user.companyId!);
  }

  // ---------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------

  /**
   * Uploads a document for extraction.
   *
   * Returns as soon as the bytes are stored; extraction happens on the poller.
   * Metered against the tenant's document quota — OCR plus embedding is a real
   * per-document cost, not a free read.
   */
  @Roles('OWNER', 'ADMIN', 'ATTORNEY', 'PARALEGAL')
  @ConsumesQuota(UsageMetric.DOCUMENTS_GENERATED)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('documents')
  @UseInterceptors(
    // memoryStorage: nothing untrusted is written to the filesystem, and the
    // size cap is applied during upload rather than after buffering a whole file.
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: MAX_UPLOAD_BYTES })
        .build({ errorHttpStatusCode: HttpStatus.PAYLOAD_TOO_LARGE }),
    )
    file: UploadedFileLike,
  ) {
    return this.ocr.ingest(file, user.companyId!, user.id);
  }

  @Get('documents')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDocumentsQuery,
  ) {
    return this.ocr.list(user.companyId!, query.status, query.take);
  }

  @Get('documents/:id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ocr.findOne(id, user.companyId!);
  }

  /** Full extracted text — the review path for a low-confidence result. */
  @Get('documents/:id/text')
  getText(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ocr.getText(id, user.companyId!);
  }

  @Roles('OWNER', 'ADMIN', 'ATTORNEY')
  @Post('documents/:id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ocr.retry(id, user.companyId!);
  }

  /**
   * Rebuilds a document's chunks and embeddings from its stored text.
   *
   * Does not re-run OCR — the extracted text is retained precisely so the
   * chunking strategy can change without paying for recognition again.
   */
  @Roles('OWNER', 'ADMIN', 'ATTORNEY')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('documents/:id/reindex')
  @HttpCode(HttpStatus.OK)
  async reindex(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    // Tenant check before the id reaches the indexer, which is not itself
    // tenant-scoped.
    await this.ocr.findOne(id, user.companyId!);
    return this.indexing.indexDocument(id);
  }

  /** Embeds chunks left unembedded by an outage. */
  @Roles('OWNER', 'ADMIN')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Post('backfill-embeddings')
  @HttpCode(HttpStatus.OK)
  backfill(@CurrentUser() user: AuthenticatedUser) {
    return this.indexing.backfillMissingEmbeddings(user.companyId!);
  }
}
