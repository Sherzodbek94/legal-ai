import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CorpusSearchService } from './search/corpus-search.service';
import { CorpusIngestionService } from './ingestion/corpus-ingestion.service';
import { CorpusSearchDto } from './dto/corpus-search.dto';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('legal-corpus')
export class LegalCorpusController {
  constructor(
    private readonly search: CorpusSearchService,
    private readonly ingestion: CorpusIngestionService,
  ) {}

  /**
   * Searches the legislation corpus.
   *
   * Available to any signed-in user and NOT tenant-scoped, because the corpus
   * is not: legislation is the same for every customer. That is also why there
   * is no `companyId` anywhere in the query — see the note on the `LegalAct`
   * model.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('search')
  find(@Query() query: CorpusSearchDto) {
    return this.search.search(query);
  }

  /** What the corpus currently holds, for the admin console and for support. */
  @Get('status')
  status() {
    return this.ingestion.status();
  }

  /**
   * Rebuilds the corpus from its configured source.
   *
   * Platform administrators only. This is not a tenant operation — it rewrites
   * data every customer reads — and it spends real money on embeddings, so it
   * is deliberately not something a company owner can trigger.
   *
   * `force` re-ingests acts whose revision is unchanged. Needed after a change
   * to the article splitter or the embedding model, when the source text is
   * identical but what should be stored for it is not.
   */
  @Roles('SUPER_ADMIN')
  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  ingest(@Body() body: { force?: boolean }) {
    return this.ingestion.ingest({ force: body?.force === true });
  }
}
