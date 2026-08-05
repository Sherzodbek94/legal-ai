import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LegalCorpusController } from './legal-corpus.controller';
import { CorpusIngestionService } from './ingestion/corpus-ingestion.service';
import { CorpusSearchService } from './search/corpus-search.service';
import { FileLegalSource } from './sources/file-legal-source';
import { LEGAL_CORPUS_SOURCE } from './sources/legal-source';
import { OcrSearchModule } from '../ocr-search/ocr-search.module';

/**
 * The legislation corpus: Uzbek statute law, indexed and citable.
 *
 * `OcrSearchModule` is imported for `OpenAiEmbeddingService` alone. Sharing the
 * embedder rather than instantiating a second one matters for correctness, not
 * just tidiness — two services could drift onto different models, and vectors
 * from different models are not comparable, so a corpus half-embedded by each
 * would return nonsense from the HNSW index without failing anywhere.
 *
 * The source is bound through a token so lex.uz, an open-data feed, or a bulk
 * export each arrive as one class and change nothing above it.
 */
@Module({
  imports: [ConfigModule, OcrSearchModule],
  controllers: [LegalCorpusController],
  providers: [
    CorpusIngestionService,
    CorpusSearchService,
    FileLegalSource,
    { provide: LEGAL_CORPUS_SOURCE, useExisting: FileLegalSource },
  ],
  exports: [CorpusSearchService, CorpusIngestionService],
})
export class LegalCorpusModule {}
