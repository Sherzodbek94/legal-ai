import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UsageMetric } from '@legaltech/database';
import { ChatService } from './chat.service';
import { AskDto } from './dto/ask.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  ConsumesQuota,
  RequiresFeature,
} from '../billing/limits/plan-limit.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * Asks a legal question.
   *
   * Metered like any other model call, and throttled below the global default:
   * this is the cheapest endpoint in the product to spend money on by holding
   * down a key.
   *
   * No `@Roles`: every member of a workspace can ask a question. What they can
   * *see* is bounded by retrieval, which searches only their own company's
   * scans alongside the shared statute corpus.
   */
  @RequiresFeature('aiGeneration')
  @ConsumesQuota(UsageMetric.AI_GENERATIONS)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('ask')
  @HttpCode(HttpStatus.OK)
  ask(@Body() dto: AskDto, @CurrentUser() user: AuthenticatedUser) {
    return this.chat.ask({
      question: dto.question,
      conversationId: dto.conversationId,
      language: dto.language,
      includeOwnDocuments: dto.includeOwnDocuments,
      companyId: user.companyId!,
      userId: user.id,
    });
  }

  @Get('conversations')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.listConversations(user.companyId!, user.id);
  }

  @Get('conversations/:id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.chat.getConversation(id, user.companyId!, user.id);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.chat.remove(id, user.companyId!, user.id);
  }
}
