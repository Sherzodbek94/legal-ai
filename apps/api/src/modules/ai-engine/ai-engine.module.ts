import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiEngineController } from './ai-engine.controller';
import { AiEngineService } from './ai-engine.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiProvider } from './providers/openai.provider';

@Module({
  imports: [ConfigModule],
  controllers: [AiEngineController],
  providers: [AiEngineService, AnthropicProvider, OpenAiProvider],
  exports: [AiEngineService],
})
export class AiEngineModule {}
