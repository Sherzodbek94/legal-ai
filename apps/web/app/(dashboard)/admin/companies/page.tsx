import { Badge } from '@/components/ui/badge';
import {
  EmptyState,
  Panel,
  PanelError,
  TableScroll,
  Td,
  Th,
} from '@/components/admin/panel';
import { LockToggle } from '@/components/admin/lock-toggle';
import { apiGet } from '@/lib/api';
import { formatDate, formatNumber } from '@/lib/format';

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  stir: string | null;
  lockedAt: string | null;
  lockedReason: string | null;
  createdAt: string;
  subscription: {
    plan: string;
    status: string;
    currentPeriodEnd: string | null;
  } | null;
  _count: { members: number; generatedDocuments: number };
}

interface CompanyList {
  items: CompanyRow[];
  nextCursor: string | null;
}

export const metadata = { title: 'Companies — Administration' };

const statusTone = (status: string | undefined) => {
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

export default async function AdminCompaniesPage({
  searchParams,
}: {
  searchParams?: { search?: string; locked?: string };
}) {
  const params = new URLSearchParams();
  if (searchParams?.search) params.set('search', searchParams.search);
  if (searchParams?.locked) params.set('locked', searchParams.locked);

  const query = params.toString();
  const result = await apiGet<CompanyList>(
    `/admin/companies${query ? `?${query}` : ''}`,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Locking a company refuses every one of its members and revokes their
          sessions. Nothing is deleted — unlocking restores access immediately.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3" action="/admin/companies">
        <div>
          <label
            htmlFor="company-search"
            className="mb-1 block text-xs text-muted-foreground"
          >
            Search by name, slug, or STIR
          </label>
          <input
            id="company-search"
            name="search"
            defaultValue={searchParams?.search ?? ''}
            className="w-72 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label
            htmlFor="company-locked"
            className="mb-1 block text-xs text-muted-foreground"
          >
            Status
          </label>
          <select
            id="company-locked"
            name="locked"
            defaultValue={searchParams?.locked ?? ''}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All</option>
            <option value="true">Locked only</option>
            <option value="false">Unlocked only</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md border border-input px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Apply
        </button>
      </form>

      <Panel
        title="All companies"
        description={
          result.ok ? `${result.data.items.length} shown` : undefined
        }
      >
        {!result.ok ? (
          <PanelError result={result} />
        ) : result.data.items.length === 0 ? (
          <EmptyState message="No companies match those filters." />
        ) : (
          <TableScroll>
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Company</Th>
                  <Th>Plan</Th>
                  <Th className="text-right">Members</Th>
                  <Th className="text-right">Documents</Th>
                  <Th>Created</Th>
                  <Th>State</Th>
                  <Th className="text-right">Action</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.data.items.map((company) => (
                  <tr key={company.id} className={company.lockedAt ? 'bg-destructive/5' : undefined}>
                    <Td>
                      <div className="font-medium">{company.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {company.slug}
                        {company.stir ? ` · STIR ${company.stir}` : ''}
                      </div>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">
                          {company.subscription?.plan ?? 'FREE'}
                        </Badge>
                        {company.subscription ? (
                          <Badge variant={statusTone(company.subscription.status)}>
                            {company.subscription.status}
                          </Badge>
                        ) : null}
                      </div>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatNumber(company._count.members)}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatNumber(company._count.generatedDocuments)}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {formatDate(company.createdAt)}
                    </Td>
                    <Td>
                      {company.lockedAt ? (
                        <div>
                          <Badge variant="destructive">Locked</Badge>
                          {company.lockedReason ? (
                            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                              {company.lockedReason}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </Td>
                    <Td className="text-right">
                      <LockToggle
                        subject="companies"
                        id={company.id}
                        locked={Boolean(company.lockedAt)}
                        label={company.name}
                      />
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
