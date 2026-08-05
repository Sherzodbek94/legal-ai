import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCentsExact } from '@/lib/format';

export interface PlanBreakdown {
  customers: number;
  mrrCents: number;
}

export interface Movement {
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnedMrrCents: number;
  netChangeCents: number;
  openingMrrCents: number;
}

/** Plans are an ordered ladder, so the ramp runs light → dark with the tier. */
const PLAN_ORDER = ['FREE', 'PRO', 'BUSINESS', 'ENTERPRISE'] as const;

/**
 * MRR by plan — magnitude across an ordered set, so a sequential ramp on one
 * hue rather than four categorical colours. The plans are not identities
 * competing for attention; they are rungs.
 */
export function MrrByPlanChart({
  byPlan,
  currency = 'USD',
}: {
  byPlan: Record<string, PlanBreakdown>;
  currency?: string;
}) {
  const rows = PLAN_ORDER.map((plan, index) => ({
    plan,
    step: `var(--seq-${index + 1})`,
    ...(byPlan[plan] ?? { customers: 0, mrrCents: 0 }),
  }));

  const max = Math.max(...rows.map((row) => row.mrrCents), 1);
  const total = rows.reduce((sum, row) => sum + row.mrrCents, 0);

  return (
    <Card className="revenue-chart">
      <CardHeader>
        <div>
          <CardTitle>MRR by plan</CardTitle>
          <CardDescription>
            Monthly recurring revenue and paying customers per tier.
          </CardDescription>
        </div>
      </CardHeader>

      {total === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          No paying customers yet.
        </p>
      ) : (
        // A table, not a div soup: this is tabular data and the chart is a
        // reading aid on top of it. Screen readers get the numbers directly.
        <table className="w-full">
          <caption className="sr-only">
            Monthly recurring revenue by subscription plan
          </caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">MRR</th>
              <th scope="col">Customers</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.plan}>
                <th
                  scope="row"
                  className="w-28 py-2.5 pl-5 pr-3 text-left text-sm font-normal"
                >
                  {row.plan.charAt(0) + row.plan.slice(1).toLowerCase()}
                </th>
                <td className="py-2.5 pr-3">
                  <div className="flex items-center gap-3">
                    <div className="h-5 min-w-px flex-1">
                      <div
                        // 4px rounded data-end, anchored to the baseline.
                        className="h-full rounded-r"
                        style={{
                          width: `${Math.max((row.mrrCents / max) * 100, row.mrrCents > 0 ? 1.5 : 0)}%`,
                          background: row.step,
                        }}
                      />
                    </div>
                    {/* Direct-labelled: the value in ink, never in the series
                        colour, so it stays legible independent of the mark. */}
                    <span className="w-24 shrink-0 text-right text-sm tabular-nums">
                      {formatCentsExact(row.mrrCents, currency)}
                    </span>
                  </div>
                </td>
                <td className="w-20 py-2.5 pr-5 text-right text-xs tabular-nums text-muted-foreground">
                  {row.customers} cust.
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/**
 * MRR movement — polarity, so a diverging bar centred on a zero axis.
 *
 * Gains extend right, losses left. Position is the primary encoding; colour
 * reinforces it and the value is direct-labelled, so nothing depends on hue
 * alone.
 */
export function MrrMovementChart({
  movement,
  currency = 'USD',
}: {
  movement: Movement;
  currency?: string;
}) {
  const rows = [
    { label: 'New', cents: movement.newMrrCents, gain: true },
    { label: 'Expansion', cents: movement.expansionMrrCents, gain: true },
    { label: 'Contraction', cents: -Math.abs(movement.contractionMrrCents), gain: false },
    { label: 'Churn', cents: -Math.abs(movement.churnedMrrCents), gain: false },
  ];

  const scale = Math.max(...rows.map((row) => Math.abs(row.cents)), 1);
  const anyMovement = rows.some((row) => row.cents !== 0);

  return (
    <Card className="revenue-chart">
      <CardHeader>
        <div>
          <CardTitle>MRR movement</CardTitle>
          <CardDescription>
            This period, against an opening balance of{' '}
            {formatCentsExact(movement.openingMrrCents, currency)}.
          </CardDescription>
        </div>
        <span
          className={`text-sm font-semibold tabular-nums ${
            movement.netChangeCents >= 0 ? 'text-success' : 'text-destructive'
          }`}
        >
          {movement.netChangeCents >= 0 ? '+' : '−'}
          {formatCentsExact(Math.abs(movement.netChangeCents), currency)}
        </span>
      </CardHeader>

      {!anyMovement ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          No movement recorded this period.
        </p>
      ) : (
        <table className="w-full">
          <caption className="sr-only">
            Monthly recurring revenue movement by category
          </caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const width = (Math.abs(row.cents) / scale) * 50;
              return (
                <tr key={row.label}>
                  <th
                    scope="row"
                    className="w-28 py-2.5 pl-5 pr-3 text-left text-sm font-normal"
                  >
                    {row.label}
                  </th>
                  <td className="py-2.5 pr-3">
                    <div className="relative h-5">
                      {/* The zero axis — recessive, but the reference every
                          bar is read against. */}
                      <div
                        aria-hidden="true"
                        className="absolute inset-y-0 left-1/2 w-px bg-border"
                      />
                      <div
                        className={`absolute inset-y-0 ${row.gain ? 'left-1/2 rounded-r' : 'right-1/2 rounded-l'}`}
                        style={{
                          width: `${Math.max(width, row.cents !== 0 ? 1 : 0)}%`,
                          background: row.gain ? 'var(--gain)' : 'var(--loss)',
                        }}
                      />
                    </div>
                  </td>
                  <td className="w-28 py-2.5 pr-5 text-right text-sm tabular-nums">
                    {row.cents === 0
                      ? '—'
                      : `${row.cents > 0 ? '+' : '−'}${formatCentsExact(Math.abs(row.cents), currency)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
