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
import { PlanPicker, type PlanView } from '@/components/billing/plan-picker';
import { apiGet } from '@/lib/api';
import { getSession } from '@/lib/session';
import { formatCents, formatCentsExact, formatDate, formatNumber } from '@/lib/format';

interface UsageRow {
  metric: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  periodStart: string;
  periodEnd: string;
}

interface PendingOrder {
  id: string;
  plan: string;
  amountCents: number;
  currency: string;
  status: string;
  description: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface Overview {
  subscription: {
    plan: string;
    planName: string;
    status: string;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    graceEndsAt: string | null;
  };
  features: Record<string, boolean>;
  usage: UsageRow[];
  recentTransactions: {
    id: string;
    amountCents: number;
    discountCents: number;
    couponCode: string | null;
    currency: string;
    status: string;
    description: string | null;
    processedAt: string | null;
    createdAt: string;
  }[];
}

export const metadata = { title: 'Billing' };

const statusTone = (status: string) => {
  switch (status) {
    case 'ACTIVE':
      return 'success' as const;
    case 'TRIALING':
      return 'secondary' as const;
    case 'PAST_DUE':
      return 'warning' as const;
    case 'UNPAID':
    case 'CANCELED':
      return 'destructive' as const;
    default:
      return 'outline' as const;
  }
};

/** `DOCUMENTS_GENERATED` reads badly in a table header. */
const METRIC_LABELS: Record<string, string> = {
  DOCUMENTS_GENERATED: 'Documents generated',
  AI_GENERATIONS: 'AI generations',
  TEMPLATES: 'Templates',
  SEATS: 'Seats',
};

export default async function BillingPage() {
  const [overview, orders, plans, session] = await Promise.all([
    apiGet<Overview>('/billing/overview'),
    apiGet<PendingOrder[]>('/payments/orders'),
    apiGet<PlanView[]>('/billing/plans'),
    getSession(),
  ]);

  // None of the four payment gateways this product integrates can charge a
  // customer without them present in a checkout flow, so a renewal that comes
  // due creates one of these instead of silently charging — see
  // RenewalService. Shown above everything else because it's the one thing on
  // this page that can interrupt service if ignored.
  const due = orders.ok
    ? orders.data.filter((order) => order.status === 'PENDING')
    : [];

  return (
    <div className="mx-auto w-full max-w-6xl animate-rise-in space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your plan, this period&rsquo;s usage, and recent charges.
        </p>
      </div>

      {!overview.ok ? (
        <Panel title="Subscription">
          <PanelError result={overview} />
        </Panel>
      ) : (
        <>
          <section aria-labelledby="plan-heading">
            <h2 id="plan-heading" className="sr-only">
              Current plan
            </h2>
            <dl className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Plan"
                value={overview.data.subscription.planName}
                hint={overview.data.subscription.status}
                tone={
                  overview.data.subscription.status === 'PAST_DUE'
                    ? 'warning'
                    : 'default'
                }
              />
              <StatCard
                label="Renews"
                value={formatDate(overview.data.subscription.currentPeriodEnd)}
                hint={
                  overview.data.subscription.cancelAtPeriodEnd
                    ? 'Cancels at period end'
                    : undefined
                }
                tone={
                  overview.data.subscription.cancelAtPeriodEnd
                    ? 'negative'
                    : 'default'
                }
              />
              <StatCard
                label="Trial ends"
                value={
                  overview.data.subscription.trialEndsAt
                    ? formatDate(overview.data.subscription.trialEndsAt)
                    : '—'
                }
              />
              <StatCard
                label="Grace period"
                value={
                  overview.data.subscription.graceEndsAt
                    ? formatDate(overview.data.subscription.graceEndsAt)
                    : '—'
                }
                hint={
                  overview.data.subscription.graceEndsAt
                    ? 'Service continues until this date'
                    : undefined
                }
                tone={overview.data.subscription.graceEndsAt ? 'negative' : 'default'}
              />
            </dl>
          </section>

          {due.length > 0 ? (
            <Panel
              title="Payment due"
              description="Complete these to keep your subscription active"
              className="border-warning/50"
            >
              <ul className="divide-y divide-border">
                {due.map((order) => (
                  <li
                    key={order.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {order.description ?? `${order.plan} renewal`}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {order.expiresAt
                          ? `Payable until ${formatDate(order.expiresAt)}`
                          : 'Contact support to complete this payment'}
                      </p>
                    </div>
                    <Badge variant="warning">
                      {formatCentsExact(order.amountCents, order.currency.toUpperCase())}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel
            title="Usage this period"
            description="Resets at the start of each billing period"
          >
            {overview.data.usage.length === 0 ? (
              <EmptyState message="No usage recorded yet." />
            ) : (
              <TableScroll>
                <table className="w-full">
                  <thead className="border-b border-border">
                    <tr>
                      <Th>Resource</Th>
                      <Th className="text-right">Used</Th>
                      <Th className="text-right">Limit</Th>
                      <Th className="w-1/3">Remaining</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {overview.data.usage.map((row) => {
                      // `null` means unmetered, which is different from zero —
                      // rendering it as 0 would read as "no allowance left".
                      //
                      // Narrowed into a local rather than via a boolean flag:
                      // TypeScript does not carry `unlimited === false` back to
                      // `row.limit`, so the flag form fails strict null checks.
                      const limit = row.limit;
                      const ratio =
                        limit === null
                          ? 0
                          : Math.min(100, (row.used / Math.max(1, limit)) * 100);

                      return (
                        <tr key={row.metric}>
                          <Td className="font-medium">
                            {METRIC_LABELS[row.metric] ?? row.metric}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {formatNumber(row.used)}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {limit === null ? 'Unlimited' : formatNumber(limit)}
                          </Td>
                          <Td>
                            {limit === null ? (
                              <span className="text-sm text-muted-foreground">—</span>
                            ) : (
                              <div className="flex items-center gap-3">
                                <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                  <span
                                    className={`block h-full rounded-full ${
                                      ratio >= 90
                                        ? 'bg-destructive'
                                        : ratio >= 70
                                          ? 'bg-warning'
                                          : 'bg-primary'
                                    }`}
                                    style={{ width: `${Math.max(2, ratio)}%` }}
                                  />
                                </span>
                                <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                                  {formatNumber(row.remaining ?? 0)}
                                </span>
                              </div>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Panel>

          {plans.ok ? (
            <Panel
              title="Change plan"
              description="Upgrades apply immediately; downgrades take effect at the end of the current period"
            >
              <PlanPicker
                plans={plans.data}
                currentPlan={overview.data.subscription.plan}
                isOwner={session.user?.companyRole === 'OWNER'}
              />
            </Panel>
          ) : (
            <Panel title="Change plan">
              <PanelError result={plans} />
            </Panel>
          )}

          <Panel title="Recent charges">
            {overview.data.recentTransactions.length === 0 ? (
              <EmptyState message="No charges yet." />
            ) : (
              <TableScroll>
                <table className="w-full">
                  <thead className="border-b border-border">
                    <tr>
                      <Th>Date</Th>
                      <Th>Description</Th>
                      <Th>Status</Th>
                      <Th className="text-right">Amount</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {overview.data.recentTransactions.map((transaction) => (
                      <tr key={transaction.id}>
                        <Td className="whitespace-nowrap text-muted-foreground">
                          {formatDate(
                            transaction.processedAt ?? transaction.createdAt,
                          )}
                        </Td>
                        <Td>
                          {transaction.description ?? '—'}
                          {transaction.couponCode ? (
                            <span className="ml-2 text-xs text-success">
                              {transaction.couponCode} (
                              {formatCents(transaction.discountCents)} off)
                            </span>
                          ) : null}
                        </Td>
                        <Td>
                          <Badge
                            variant={
                              transaction.status === 'SUCCEEDED'
                                ? 'success'
                                : transaction.status === 'FAILED'
                                  ? 'destructive'
                                  : 'secondary'
                            }
                          >
                            {transaction.status}
                          </Badge>
                        </Td>
                        <Td className="text-right font-medium tabular-nums">
                          {formatCentsExact(
                            transaction.amountCents - transaction.discountCents,
                            transaction.currency.toUpperCase(),
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Panel>

          <p className="text-xs text-muted-foreground">
            Renewals are collected by payment link rather than an automatic
            debit — none of the available gateways supports charging without
            you present. You will be emailed when one is due.
          </p>
        </>
      )}
    </div>
  );
}
