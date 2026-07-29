import { Body, Controller, Post } from '@nestjs/common';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('analyze')
  analyze(@Body('documentId') documentId: string) {
    return this.aiService.analyzeDocument(documentId);
  }
}
