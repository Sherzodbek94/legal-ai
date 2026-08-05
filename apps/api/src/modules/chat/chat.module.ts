import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { LegalCorpusModule } from '../legal-corpus/legal-corpus.module';
import { OcrSearchModule } from '../ocr-search/ocr-search.module';
import { AiEngineModule } from '../ai-engine/ai-engine.module';

/**
 * Legal chat.
 *
 * Composes three modules it does not own: the statute corpus, the tenant's own
 * document search, and the model. That is the whole design — the value is in
 * putting a numbered, checkable source list in front of the model, not in any
 * new retrieval or inference of its own.
 */
@Module({
  imports: [LegalCorpusModule, OcrSearchModule, AiEngineModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
