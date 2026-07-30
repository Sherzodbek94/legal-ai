import { Badge } from '@/components/ui/badge';
import {
  EmptyState,
  Panel,
  PanelError,
  StatCard,
  TableScroll,
  Td,
  Th,
} from '@/components/admin/panel';
import { apiGet } from '@/lib/api';
import {
  formatCompact,
  formatDate,
  formatMicroUsd,
  formatNumber,
} from '@/lib/format';

interface CostSummary {
  window: { from: string; to: string };
  calls: number;
  totalCostMicroUsd: number;
  averageCostPerCallMicroUsd: number;
  tokens: { input: number; output: number; cachedInput: number };
  byModel: {
    model: string;
    calls: number;
    costMicroUsd: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  byProvider: { provider: string; calls: number; costMicroUsd: number }[];
}

interface CompanyCost {
  companyId: string | null;
  companyName: string;
  plan: string | null;
  subscriptionStatus: string | null;
  calls: number;
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface DailyCost {
  day: string;
  calls: number;
  costMicroUsd: number;
}

export const metadata = { title: 'AI costs — Administration' };

export default async function AdminAiCostsPage() {
  const [summary, byCompany, daily] = await Promise.all([
    apiGet<CostSummary>('/admin/ai-costs'),
    apiGet<CompanyCost[]>('/admin/ai-costs/by-company?take=25'),
    apiGet<DailyCost[]>('/admin/ai-costs/daily'),
  ]);

  const peakDailyCost = daily.ok
    ? Math.max(1, ...daily.data.map((day) => day.costMicroUsd))
    : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI costs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Model spend for the current calendar month, priced from list rates. An
          unrecognised model is charged at the highest known rate rather than
          zero, so a missing price shows up as an overstatement instead of
          silence.
        </p>
      </div>

      {!summary.ok ? (
        <Panel title="Spend">
          <PanelError result={summary} />
        </Panel>
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total spend"
              value={formatMicroUsd(summary.data.totalCostMicroUsd, 2)}
              hint={`${formatDate(summary.data.window.from)} onward`}
            />
            <StatCard
              label="Calls"
              value={formatNumber(summary.data.calls)}
              hint={`avg ${formatMicroUsd(summary.data.averageCostPerCallMicroUsd)} each`}
            />
            <StatCard
              label="Input tokens"
              value={formatCompact(summary.data.tokens.input)}
              hint={`${formatCompact(summary.data.tokens.cachedInput)} cached`}
            />
            <StatCard
              label="Output tokens"
              value={formatCompact(summary.data.tokens.output)}
              hint="Priced well above input on every model"
            />
          </dl>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="By model" description="Most expensive first">
              {summary.data.byModel.length === 0 ? (
                <EmptyState message="No model calls recorded this month." />
              ) : (
                <TableScroll>
                  <table className="w-full">
                    <thead className="border-b border-border">
                      <tr>
                        <Th>Model</Th>
                        <Th className="text-right">Calls</Th>
                        <Th className="text-right">Tokens in / out</Th>
                        <Th className="text-right">Cost</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {summary.data.byModel.map((row) => (
                        <tr key={row.model}>
                          <Td className="font-medium">{row.model}</Td>
                          <Td className="text-right tabular-nums">
                            {formatNumber(row.calls)}
                          </Td>
                          <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                            {formatCompact(row.inputTokens)} /{' '}
                            {formatCompact(row.outputTokens)}
                          </Td>
                          <Td className="text-right font-medium tabular-nums">
                            {formatMicroUsd(row.costMicroUsd, 2)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </Panel>

            <Panel title="Daily spend" description="Current month">
              {!daily.ok ? (
                <PanelError result={daily} />
              ) : daily.data.length === 0 ? (
                <EmptyState message="No spend recorded this month." />
              ) : (
                <ul className="space-y-2 px-5 py-4">
                  {daily.data.map((day) => (
                    <li key={day.day} className="flex items-center gap-3">
                      <span className="w-16 shrink-0 text-xs text-muted-foreground">
                        {formatDate(day.day)}
                      </span>
                      {/* A plain proportional bar rather than a charting
                          dependency — the shape is the whole message. */}
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{
                            width: `${Math.max(2, (day.costMicroUsd / peakDailyCost) * 100)}%`,
                          }}
                        />
                      </span>
                      <span className="w-20 shrink-0 text-right text-xs tabular-nums">
                        {formatMicroUsd(day.costMicroUsd, 2)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}

      <Panel
        title="By company"
        description="Whether one tenant is responsible for a disproportionate share of the vendor bill"
      >
        {!byCompany.ok ? (
          <PanelError result={byCompany} />
        ) : byCompany.data.length === 0 ? (
          <EmptyState message="No tenant-attributed spend this month." />
        ) : (
          <TableScroll>
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Company</Th>
                  <Th>Plan</Th>
                  <Th className="text-right">Calls</Th>
                  <Th className="text-right">Tokens in / out</Th>
                  <Th className="text-right">Cost</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {byCompany.data.map((row) => (
                  <tr key={row.companyId ?? row.companyName}>
                    <Td className="font-medium">{row.companyName}</Td>
                    <Td>
                      <Badge variant={row.plan === 'FREE' ? 'outline' : 'secondary'}>
                        {row.plan ?? 'FREE'}
                      </Badge>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatNumber(row.calls)}
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                      {formatCompact(row.inputTokens)} /{' '}
                      {formatCompact(row.outputTokens)}
                    </Td>
                    <Td className="text-right font-medium tabular-nums">
                      {formatMicroUsd(row.costMicroUsd, 2)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
