import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChatRole, Prisma } from '@legaltech/database';
import { PrismaService } from '../../prisma/prisma.service';
import { CorpusSearchService } from '../legal-corpus/search/corpus-search.service';
import { HybridSearchService } from '../ocr-search/search/hybrid-search.service';
import { AiEngineService } from '../ai-engine/ai-engine.service';
import { redactPii, restorePii } from '../../common/pii/pii-redactor';
import {
  buildChatSystemPrompt,
  buildSourcesBlock,
  type PromptSource,
} from './prompts/legal-chat-prompt';
import {
  checkCitations,
  isUngrounded,
  stripInvented,
  type ResolvedCitation,
} from './citations';

/** A retrieved source plus the text that goes into the prompt but not the row. */
interface RetrievedSource extends ResolvedCitation {
  text: string;
}

export interface AskInput {
  conversationId?: string;
  question: string;
  language?: string;
  /** Also search this company's own uploaded scans, not only the statute book. */
  includeOwnDocuments?: boolean;
  companyId: string;
  userId: string;
}

/**
 * Answering legal questions from retrieved sources.
 *
 * The competitor's whole proposition is "answers grounded in Uzbek law with
 * lex.uz sources", and this is the equivalent — with one difference that
 * matters: the answer is checked against what was actually retrieved. A model
 * that invents an article reference produces something a lawyer cannot
 * distinguish from a real one, so sources are numbered `[S1]`…`[Sn]` and any
 * token the model did not receive is stripped before the answer is shown.
 *
 * Two corpora are searched. The statute corpus is shared and cited by article;
 * the company's own scans are private and cited by document. Both go into one
 * numbered list, because a lawyer asking "can I terminate under this contract"
 * wants the law and their own contract in the same answer.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  /**
   * How many sources reach the prompt.
   *
   * Six, not twenty. Every source is a paragraph of statute or a page of scan,
   * and a model handed twenty of them answers from the two it liked rather
   * than the one that was relevant — while the caller pays for all twenty.
   */
  private static readonly CORPUS_SOURCES = 4;
  private static readonly DOCUMENT_SOURCES = 2;

  /** Turns of history replayed into the prompt. */
  private static readonly HISTORY_TURNS = 6;

  constructor(
    private readonly prisma: PrismaService,
    private readonly corpus: CorpusSearchService,
    private readonly documents: HybridSearchService,
    private readonly ai: AiEngineService,
  ) {}

  async ask(input: AskInput) {
    const language = input.language ?? 'uz-Latn';

    const conversation = input.conversationId
      ? await this.load(input.conversationId, input.companyId, input.userId)
      : await this.prisma.client.chatConversation.create({
          data: {
            companyId: input.companyId,
            userId: input.userId,
            // The first question, trimmed. A thread called "New conversation"
            // is unfindable in a sidebar of twenty.
            title: input.question.slice(0, 120),
          },
        });

    const sources = await this.retrieve(input, language);

    const history = await this.prisma.client.chatMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: ChatService.HISTORY_TURNS,
      select: { role: true, content: true },
    });

    const userPrompt = [
      ...history
        .reverse()
        .map((turn) => `${turn.role === ChatRole.USER ? 'SAVOL' : 'JAVOB'}: ${turn.content}`),
      buildSourcesBlock(sources.map(toPromptSource)),
      `SAVOL: ${input.question}`,
    ].join('\n\n');

    // The question and the retrieved scans both routinely carry identifiers —
    // a client's passport in a question, an account number in a contract that
    // was uploaded. None of it helps the model reason about the law.
    const { text: redacted, redactions } = redactPii(userPrompt);

    const result = await this.ai.answerLegalQuestion({
      systemPrompt: buildChatSystemPrompt(language),
      userPrompt: redacted,
      companyId: input.companyId,
      userId: input.userId,
    });

    const answer = restorePii(result.text, userPrompt);

    const check = checkCitations(answer, sources);

    if (check.invented.length > 0) {
      // Worth a log line: a model citing sources it was not given is the
      // failure this whole design exists to catch, and a rise in it means the
      // prompt or the model has drifted.
      this.logger.warn(
        `Model cited ${check.invented.length} source(s) it was not given: ${check.invented.join(', ')}`,
      );
    }

    const cleaned = stripInvented(answer, check.invented);
    const ungrounded = isUngrounded(check, sources.length);

    const [, assistant] = await this.prisma.client.$transaction([
      this.prisma.client.chatMessage.create({
        data: {
          conversationId: conversation.id,
          role: ChatRole.USER,
          content: input.question,
        },
      }),
      this.prisma.client.chatMessage.create({
        data: {
          conversationId: conversation.id,
          role: ChatRole.ASSISTANT,
          content: cleaned,
          citations: check.cited.map(toStored) as unknown as Prisma.InputJsonValue,
          provider: result.provider,
          model: result.model,
          ungrounded,
        },
      }),
      this.prisma.client.chatConversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      }),
    ]);

    if (redactions.length > 0) {
      this.logger.log(
        `Redacted ${redactions.length} identifier(s) before answering`,
      );
    }

    return {
      conversationId: conversation.id,
      messageId: assistant.id,
      answer: cleaned,
      citations: check.cited.map(toStored),
      ungrounded,
      provider: result.provider,
      model: result.model,
    };
  }

  /**
   * Retrieves from both corpora and numbers the results.
   *
   * Statute first, then the company's own documents. The order is the citation
   * order the reader sees, and law before evidence is how a legal answer is
   * conventionally built.
   */
  private async retrieve(input: AskInput, language: string): Promise<RetrievedSource[]> {
    const wantDocuments = input.includeOwnDocuments !== false;

    const [corpus, documents] = await Promise.all([
      this.corpus
        .search({
          q: input.question,
          language: language === 'ru' ? 'ru' : undefined,
          limit: ChatService.CORPUS_SOURCES,
        })
        .catch((error: unknown) => {
          // A corpus that is empty or unreachable must not fail the question.
          // The answer then says it has no sources, which is honest.
          this.logger.warn(
            `Corpus retrieval failed: ${(error as Error)?.message ?? 'unknown'}`,
          );
          return { hits: [] };
        }),
      wantDocuments
        ? this.documents
            .search(
              { q: input.question, limit: ChatService.DOCUMENT_SOURCES },
              input.companyId,
            )
            .catch(() => ({ hits: [] }))
        : Promise.resolve({ hits: [] }),
    ]);

    const sources: RetrievedSource[] = [];

    for (const hit of corpus.hits) {
      sources.push({
        token: `S${sources.length + 1}`,
        kind: 'corpus',
        refId: hit.chunkId,
        citation: hit.citation,
        url: hit.url,
        superseded: hit.superseded,
        // Carried for the prompt; dropped by `toStored` before it reaches a row.
        text: hit.snippet,
      });
    }

    for (const hit of documents.hits) {
      sources.push({
        token: `S${sources.length + 1}`,
        kind: 'document',
        refId: hit.documentId,
        citation: hit.originalName + (hit.page ? `, ${hit.page}-bet` : ''),
        url: null,
        superseded: false,
        text: hit.snippet,
      });
    }

    return sources;
  }

  async listConversations(companyId: string, userId: string) {
    return this.prisma.client.chatConversation.findMany({
      where: { companyId, userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  async getConversation(id: string, companyId: string, userId: string) {
    const conversation = await this.load(id, companyId, userId);

    const messages = await this.prisma.client.chatMessage.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        role: true,
        content: true,
        citations: true,
        ungrounded: true,
        createdAt: true,
      },
    });

    return { ...conversation, messages };
  }

  async remove(id: string, companyId: string, userId: string) {
    await this.load(id, companyId, userId);

    await this.prisma.client.chatConversation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Scoped to the company AND the asking user.
   *
   * A thread quotes whatever the asker could see, so it is theirs rather than
   * the workspace's — a paralegal's research should not appear in the owner's
   * sidebar just because they share a tenant.
   */
  private async load(id: string, companyId: string, userId: string) {
    const conversation = await this.prisma.client.chatConversation.findFirst({
      where: { id, companyId, userId, deletedAt: null },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }
}

function toPromptSource(source: RetrievedSource): PromptSource {
  return {
    token: source.token,
    citation: source.citation,
    text: source.text,
    superseded: source.superseded,
  };
}

/**
 * The citation as it is stored, without the source text.
 *
 * A statute passage can run to a page, and storing it on every message would
 * copy the corpus into the chat log — the `refId` is enough to open the source
 * again.
 */
function toStored(source: ResolvedCitation): ResolvedCitation {
  const { token, kind, refId, citation, url, superseded } = source;
  return { token, kind, refId, citation, url, superseded };
}
