import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { computeCostMicroUsd, formatMicroUsd } from './ai-pricing';

export interface RecordUsageInput {
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  companyId?: string;
  userId?: string;
}

@Injectable()
export class AiCostService {
  private readonly logger = new Logger(AiCostService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records the cost of one model call.
   *
   * Never throws. This is measurement attached to a request the customer already
   * paid for — failing their document generation because a metrics insert
   * failed would be the wrong trade every time. A dropped record is visible in
   * the logs and reconcilable against the vendor invoice.
   */
  async record(input: RecordUsageInput): Promise<void> {
    try {
      const { costMicroUsd, pricedModel } = computeCostMicroUsd(input.model, input);

      if (!pricedModel) {
        // Priced at the most expensive entry rather than zero — see ai-pricing.
        this.logger.warn(
          `No pricing entry for model "${input.model}"; charged at the highest known rate. Update MODEL_PRICING.`,
        );
      }

      await this.prisma.client.aiUsageRecord.create({
        data: {
          companyId: input.companyId,
          userId: input.userId,
          provider: input.provider,
          model: input.model,
          operation: input.operation,
          inputTokens: Math.max(0, input.inputTokens),
          outputTokens: Math.max(0, input.outputTokens),
          cachedInputTokens: Math.max(0, input.cachedInputTokens ?? 0),
          costMicroUsd,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record AI usage for model ${input.model}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
    }
  }

  /** Platform-wide cost summary over a window. */
  async getSummary(from: Date, to: Date) {
    const [totals, byModel, byProvider] = await Promise.all([
      this.prisma.client.aiUsageRecord.aggregate({
        where: { createdAt: { gte: from, lt: to } },
        _sum: {
          costMicroUsd: true,
          inputTokens: true,
          outputTokens: true,
          cachedInputTokens: true,
        },
        _count: { _all: true },
      }),
      this.prisma.client.aiUsageRecord.groupBy({
        by: ['model'],
        where: { createdAt: { gte: from, lt: to } },
        _sum: { costMicroUsd: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
      this.prisma.client.aiUsageRecord.groupBy({
        by: ['provider'],
        where: { createdAt: { gte: from, lt: to } },
        _sum: { costMicroUsd: true },
        _count: { _all: true },
      }),
    ]);

    const totalMicroUsd = totals._sum.costMicroUsd ?? 0;
    const calls = totals._count._all;

    return {
      window: { from, to },
      calls,
      totalCostMicroUsd: totalMicroUsd,
      totalCostUsd: formatMicroUsd(totalMicroUsd, 2),
      averageCostPerCallMicroUsd:
        calls === 0 ? 0 : Math.round(totalMicroUsd / calls),
      tokens: {
        input: totals._sum.inputTokens ?? 0,
        output: totals._sum.outputTokens ?? 0,
        cachedInput: totals._sum.cachedInputTokens ?? 0,
      },
      byModel: byModel
        .map((row) => ({
          model: row.model,
          calls: row._count._all,
          costMicroUsd: row._sum.costMicroUsd ?? 0,
          costUsd: formatMicroUsd(row._sum.costMicroUsd ?? 0, 2),
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
        }))
        .sort((a, b) => b.costMicroUsd - a.costMicroUsd),
      byProvider: byProvider.map((row) => ({
        provider: row.provider,
        calls: row._count._all,
        costMicroUsd: row._sum.costMicroUsd ?? 0,
        costUsd: formatMicroUsd(row._sum.costMicroUsd ?? 0, 2),
      })),
    };
  }

  /**
   * Cost by tenant, most expensive first.
   *
   * The question this exists to answer is whether one customer is responsible
   * for a disproportionate share of the vendor bill — which is a margin problem
   * long before it is a capacity one.
   */
  async getCostByCompany(from: Date, to: Date, take = 50) {
    const grouped = await this.prisma.client.aiUsageRecord.groupBy({
      by: ['companyId'],
      where: { createdAt: { gte: from, lt: to }, companyId: { not: null } },
      _sum: { costMicroUsd: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { costMicroUsd: 'desc' } },
      take: Math.min(take, 200),
    });

    const companyIds = grouped
      .map((row) => row.companyId)
      .filter((id): id is string => id !== null);

    const companies = await this.prisma.client.company.findMany({
      where: { id: { in: companyIds } },
      select: {
        id: true,
        name: true,
        subscription: { select: { plan: true, status: true } },
      },
    });
    const byId = new Map(companies.map((company) => [company.id, company]));

    return grouped.map((row) => {
      const company = row.companyId ? byId.get(row.companyId) : undefined;
      const costMicroUsd = row._sum.costMicroUsd ?? 0;

      return {
        companyId: row.companyId,
        companyName: company?.name ?? 'Unknown',
        plan: company?.subscription?.plan ?? null,
        subscriptionStatus: company?.subscription?.status ?? null,
        calls: row._count._all,
        costMicroUsd,
        costUsd: formatMicroUsd(costMicroUsd, 2),
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
      };
    });
  }

  /**
   * Daily cost series, for spotting the day a prompt change got expensive.
   *
   * Grouped in SQL rather than in JS: the table grows by one row per model call
   * and pulling a month of them into memory to bucket by day would not survive
   * contact with real traffic.
   */
  async getDailySeries(from: Date, to: Date) {
    const rows = await this.prisma.client.$queryRaw<
      { day: Date; calls: bigint; cost: bigint }[]
    >`
      SELECT date_trunc('day', "createdAt") AS day,
             COUNT(*)                       AS calls,
             COALESCE(SUM("costMicroUsd"), 0) AS cost
        FROM "ai_usage_records"
       WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
       GROUP BY 1
       ORDER BY 1 ASC
    `;

    return rows.map((row) => ({
      day: row.day,
      calls: Number(row.calls),
      costMicroUsd: Number(row.cost),
      costUsd: formatMicroUsd(Number(row.cost), 2),
    }));
  }
}
