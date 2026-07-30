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
import { EndImpersonationButton } from '@/components/admin/impersonate-button';
import { apiGet } from '@/lib/api';
import {
  formatCents,
  formatDateTime,
  formatNumber,
  formatRate,
  formatRelative,
  formatSignedCents,
} from '@/lib/format';

interface Dashboard {
  revenue: {
    mrrCents: number;
    arrCents: number;
    payingCustomers: number;
    arpaCents: number;
    byPlan: Record<string, { customers: number; mrrCents: number }>;
  };
  movement: {
    newMrrCents: number;
    expansionMrrCents: number;
    contractionMrrCents: number;
    churnedMrrCents: number;
    netChangeCents: number;
    revenueChurnRate: number | null;
    customerChurnRate: number | null;
    estimatedLtvCents: number | null;
  };
  stats: {
    companies: { total: number; locked: number };
    users: { total: number; locked: number };
    documents: { total: number; completed: number };
    subscriptions: { trialing: number; pastDue: number };
  };
}

interface ActiveSession {
  id: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  impersonator: { id: string; email: string; name: string | null };
  targetUser: { id: string; email: string; name: string | null };
}

export const metadata = { title: 'Administration' };

export default async function AdminOverviewPage() {
  const [dashboard, sessions] = await Promise.all([
    apiGet<Dashboard>('/admin/dashboard'),
    apiGet<ActiveSession[]>('/admin/impersonation/active'),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Recurring revenue, platform totals, and anything currently in flight.
        </p>
      </div>

      {!dashboard.ok ? (
        <Panel title="Revenue">
          <PanelError result={dashboard} />
        </Panel>
      ) : (
        <>
          <section aria-labelledby="revenue-heading">
            <h2 id="revenue-heading" className="sr-only">
              Recurring revenue
            </h2>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="MRR"
                value={formatCents(dashboard.data.revenue.mrrCents)}
                hint="Active and past-due subscriptions, net of discounts"
              />
              <StatCard
                label="ARR"
                value={formatCents(dashboard.data.revenue.arrCents)}
                hint="MRR × 12 — a run rate, not trailing revenue"
              />
              <StatCard
                label="Paying customers"
                value={formatNumber(dashboard.data.revenue.payingCustomers)}
                hint="Excludes trials and Free"
              />
              <StatCard
                label="ARPA"
                value={formatCents(dashboard.data.revenue.arpaCents)}
                hint="Average per paying account"
              />
            </dl>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel
              title="MRR movement this month"
              description="Reconstructed from charges in the prior month — see the note below"
            >
              <dl className="divide-y divide-border">
                {[
                  {
                    label: 'New',
                    value: dashboard.data.movement.newMrrCents,
                    tone: 'positive' as const,
                  },
                  {
                    label: 'Expansion',
                    value: dashboard.data.movement.expansionMrrCents,
                    tone: 'positive' as const,
                  },
                  {
                    label: 'Contraction',
                    value: -dashboard.data.movement.contractionMrrCents,
                    tone: 'negative' as const,
                  },
                  {
                    label: 'Churned',
                    value: -dashboard.data.movement.churnedMrrCents,
                    tone: 'negative' as const,
                  },
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between px-5 py-3"
                  >
                    <dt className="text-sm text-muted-foreground">{row.label}</dt>
                    <dd
                      className={`text-sm font-medium tabular-nums ${
                        row.value === 0
                          ? 'text-muted-foreground'
                          : row.tone === 'positive'
                            ? 'text-success'
                            : 'text-destructive'
                      }`}
                    >
                      {formatSignedCents(row.value)}
                    </dd>
                  </div>
                ))}
                <div className="flex items-center justify-between bg-muted/40 px-5 py-3">
                  <dt className="text-sm font-semibold">Net change</dt>
                  <dd className="text-sm font-semibold tabular-nums">
                    {formatSignedCents(dashboard.data.movement.netChangeCents)}
                  </dd>
                </div>
              </dl>
              <div className="grid grid-cols-3 gap-3 border-t border-border px-5 py-4 text-center">
                <div>
                  <p className="text-xs text-muted-foreground">Revenue churn</p>
                  <p className="mt-0.5 text-sm font-medium tabular-nums">
                    {formatRate(dashboard.data.movement.revenueChurnRate)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Customer churn</p>
                  <p className="mt-0.5 text-sm font-medium tabular-nums">
                    {formatRate(dashboard.data.movement.customerChurnRate)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Est. LTV</p>
                  <p className="mt-0.5 text-sm font-medium tabular-nums">
                    {dashboard.data.movement.estimatedLtvCents === null
                      ? '—'
                      : formatCents(dashboard.data.movement.estimatedLtvCents)}
                  </p>
                </div>
              </div>
            </Panel>

            <Panel title="Plan distribution">
              <TableScroll>
                <table className="w-full">
                  <thead className="border-b border-border">
                    <tr>
                      <Th>Plan</Th>
                      <Th className="text-right">Accounts</Th>
                      <Th className="text-right">MRR</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {Object.entries(dashboard.data.revenue.byPlan).map(
                      ([plan, row]) => (
                        <tr key={plan}>
                          <Td>
                            <Badge variant={plan === 'FREE' ? 'outline' : 'secondary'}>
                              {plan}
                            </Badge>
                          </Td>
                          <Td className="text-right tabular-nums">
                            {formatNumber(row.customers)}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {formatCents(row.mrrCents)}
                          </Td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </TableScroll>
            </Panel>
          </div>

          <section aria-labelledby="platform-heading">
            <h2
              id="platform-heading"
              className="mb-4 text-lg font-semibold tracking-tight"
            >
              Platform
            </h2>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Companies"
                value={formatNumber(dashboard.data.stats.companies.total)}
                hint={`${dashboard.data.stats.companies.locked} locked`}
                tone={dashboard.data.stats.companies.locked > 0 ? 'warning' : 'default'}
              />
              <StatCard
                label="Users"
                value={formatNumber(dashboard.data.stats.users.total)}
                hint={`${dashboard.data.stats.users.locked} locked`}
                tone={dashboard.data.stats.users.locked > 0 ? 'warning' : 'default'}
              />
              <StatCard
                label="Documents"
                value={formatNumber(dashboard.data.stats.documents.total)}
                hint={`${formatNumber(dashboard.data.stats.documents.completed)} approved`}
              />
              <StatCard
                label="Past due"
                value={formatNumber(dashboard.data.stats.subscriptions.pastDue)}
                hint={`${dashboard.data.stats.subscriptions.trialing} on trial`}
                tone={
                  dashboard.data.stats.subscriptions.pastDue > 0
                    ? 'negative'
                    : 'default'
                }
              />
            </dl>
          </section>
        </>
      )}

      <Panel
        title="Active impersonation sessions"
        description="Live support sessions across the platform"
      >
        {!sessions.ok ? (
          <PanelError result={sessions} />
        ) : sessions.data.length === 0 ? (
          <EmptyState message="No impersonation sessions are active." />
        ) : (
          <TableScroll>
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Operator</Th>
                  <Th>Acting as</Th>
                  <Th>Reason</Th>
                  <Th>Started</Th>
                  <Th>Expires</Th>
                  <Th className="text-right">Action</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sessions.data.map((session) => (
                  <tr key={session.id}>
                    <Td className="font-medium">{session.impersonator.email}</Td>
                    <Td>{session.targetUser.email}</Td>
                    <Td className="max-w-xs truncate text-muted-foreground">
                      {session.reason}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {formatRelative(session.startedAt)}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(session.expiresAt)}
                    </Td>
                    <Td className="text-right">
                      <EndImpersonationButton sessionId={session.id} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <p className="text-xs text-muted-foreground">
        MRR movement compares current subscriptions against successful charges in
        the previous calendar month. That attributes revenue to whoever actually
        paid, so a mid-month signup appears at their charged amount rather than a
        prorated one. A nightly MRR snapshot would make it exact.
      </p>
    </div>
  );
}
