import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class AiService {
  async analyzeDocument(_documentId: string) {
    throw new NotImplementedException('AI analysis pipeline not yet configured');
  }
}
