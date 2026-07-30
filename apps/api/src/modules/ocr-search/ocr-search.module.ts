import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OcrSearchController } from './ocr-search.controller';
import { OcrService } from './ocr/ocr.service';
import { TesseractWorker } from './ocr/tesseract.worker';
import { PdfTextExtractor } from './ocr/pdf-text-extractor';
import { OpenAiEmbeddingService } from './embedding/openai-embedding.service';
import { IndexingService } from './embedding/indexing.service';
import { HybridSearchService } from './search/hybrid-search.service';

/**
 * OCR and hybrid search.
 *
 * Three stages that only make sense together: get text out of a scan, turn it
 * into embedded passages, and retrieve those passages by both meaning and exact
 * wording.
 *
 * TesseractWorker holds WASM workers with substantial resident memory, so it is a
 * singleton here and terminates them on module destroy — otherwise the process
 * will not exit cleanly.
 */
@Module({
  imports: [ConfigModule],
  controllers: [OcrSearchController],
  providers: [
    OcrService,
    TesseractWorker,
    PdfTextExtractor,
    OpenAiEmbeddingService,
    IndexingService,
    HybridSearchService,
  ],
  exports: [OcrService, IndexingService, HybridSearchService, OpenAiEmbeddingService],
})
export class OcrSearchModule {}
