import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  EmptyState,
  Panel,
  PanelError,
  TableScroll,
  Td,
  Th,
} from '@/components/admin/panel';
import { apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
  user: { id: string; email: string; name: string | null } | null;
  company: { id: string; name: string } | null;
}

interface AuditList {
  items: AuditEntry[];
  nextCursor: string | null;
}

interface Filters {
  actions: string[];
  entityTypes: { entityType: string; count: number }[];
}

export const metadata = { title: 'Audit log — Administration' };

const actionTone = (action: string) => {
  switch (action) {
    case 'DELETE':
      return 'destructive' as const;
    case 'CREATE':
      return 'success' as const;
    case 'LOGIN':
    case 'LOGOUT':
      return 'secondary' as const;
    default:
      return 'outline' as const;
  }
};

/** Events worth a visual flag when scanning the trail. */
const SECURITY_EVENTS = new Set([
  'USER_LOCKED',
  'USER_UNLOCKED',
  'COMPANY_LOCKED',
  'COMPANY_UNLOCKED',
  'IMPERSONATION_STARTED',
  'IMPERSONATION_ENDED',
  'IMPERSONATION_SESSIONS_REVOKED',
]);

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams?: {
    action?: string;
    entityType?: string;
    userId?: string;
    companyId?: string;
    cursor?: string;
  };
}) {
  const params = new URLSearchParams();
  for (const key of ['action', 'entityType', 'userId', 'companyId', 'cursor'] as const) {
    const value = searchParams?.[key];
    if (value) params.set(key, value);
  }

  const query = params.toString();
  const [result, filters] = await Promise.all([
    apiGet<AuditList>(`/admin/audit${query ? `?${query}` : ''}`),
    apiGet<Filters>('/admin/audit/filters'),
  ]);

  // The cursor is dropped from the "next page" link's inherited filters and
  // replaced, so paging does not accumulate stale cursors.
  const nextParams = new URLSearchParams(params);
  if (result.ok && result.data.nextCursor) {
    nextParams.set('cursor', result.data.nextCursor);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Append-only. Entries cannot be edited or removed — retention is handled
          by time-based pruning, not by deletion.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3" action="/admin/audit">
        <div>
          <label
            htmlFor="audit-action"
            className="mb-1 block text-xs text-muted-foreground"
          >
            Action
          </label>
          <select
            id="audit-action"
            name="action"
            defaultValue={searchParams?.action ?? ''}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All actions</option>
            {(filters.ok ? filters.data.actions : []).map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="audit-entity"
            className="mb-1 block text-xs text-muted-foreground"
          >
            Entity type
          </label>
          <select
            id="audit-entity"
            name="entityType"
            defaultValue={searchParams?.entityType ?? ''}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All entities</option>
            {(filters.ok ? filters.data.entityTypes : []).map((entity) => (
              <option key={entity.entityType} value={entity.entityType}>
                {entity.entityType} ({entity.count})
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md border border-input px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Apply
        </button>
        <Link
          href="/admin/audit"
          className="px-2 py-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Reset
        </Link>
      </form>

      <Panel title="Entries">
        {!result.ok ? (
          <PanelError result={result} />
        ) : result.data.items.length === 0 ? (
          <EmptyState message="No audit entries match those filters." />
        ) : (
          <>
            <TableScroll>
              <table className="w-full">
                <thead className="border-b border-border">
                  <tr>
                    <Th>When</Th>
                    <Th>Actor</Th>
                    <Th>Action</Th>
                    <Th>Entity</Th>
                    <Th>Detail</Th>
                    <Th>IP</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.data.items.map((entry) => {
                    const event = entry.metadata?.event;
                    const isSecurity =
                      typeof event === 'string' && SECURITY_EVENTS.has(event);

                    return (
                      <tr
                        key={entry.id}
                        className={isSecurity ? 'bg-warning/5' : undefined}
                      >
                        <Td className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(entry.createdAt)}
                        </Td>
                        <Td>
                          {entry.user ? (
                            <div>
                              <div className="text-sm">{entry.user.email}</div>
                              {entry.company ? (
                                <div className="text-xs text-muted-foreground">
                                  {entry.company.name}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">system</span>
                          )}
                        </Td>
                        <Td>
                          <Badge variant={actionTone(entry.action)}>
                            {entry.action}
                          </Badge>
                        </Td>
                        <Td>
                          <div className="text-sm">{entry.entityType}</div>
                          {entry.entityId ? (
                            <div className="font-mono text-xs text-muted-foreground">
                              {entry.entityId.slice(-12)}
                            </div>
                          ) : null}
                        </Td>
                        <Td className="max-w-md">
                          {typeof event === 'string' ? (
                            <span
                              className={
                                isSecurity
                                  ? 'font-medium text-warning-foreground'
                                  : 'font-medium'
                              }
                            >
                              {event}
                            </span>
                          ) : null}
                          {entry.metadata ? (
                            <details className="mt-0.5">
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                metadata
                              </summary>
                              {/* Overflow-scrolled: audit metadata is arbitrary
                                  JSON and some of it is long. */}
                              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
                                {JSON.stringify(entry.metadata, null, 2)}
                              </pre>
                            </details>
                          ) : null}
                        </Td>
                        <Td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                          {entry.ipAddress ?? '—'}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>

            {result.data.nextCursor ? (
              <div className="border-t border-border px-5 py-3 text-right">
                <Link
                  href={`/admin/audit?${nextParams.toString()}`}
                  className="text-sm font-medium underline-offset-4 hover:underline"
                >
                  Next page →
                </Link>
              </div>
            ) : null}
          </>
        )}
      </Panel>
    </div>
  );
}
