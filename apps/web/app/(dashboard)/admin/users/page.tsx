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
import { ImpersonateButton } from '@/components/admin/impersonate-button';
import { apiGet } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: 'SUPER_ADMIN' | 'USER';
  lastLoginAt: string | null;
  lockedAt: string | null;
  lockedReason: string | null;
  createdAt: string;
  memberships: {
    role: string;
    company: { id: string; name: string; lockedAt: string | null };
  }[];
}

interface UserList {
  items: UserRow[];
  nextCursor: string | null;
}

export const metadata = { title: 'Users — Administration' };

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams?: { search?: string; locked?: string };
}) {
  const params = new URLSearchParams();
  if (searchParams?.search) params.set('search', searchParams.search);
  if (searchParams?.locked) params.set('locked', searchParams.locked);

  const query = params.toString();
  const result = await apiGet<UserList>(`/admin/users${query ? `?${query}` : ''}`);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Locking an account revokes its sessions immediately. Impersonation lasts
          15 minutes, requires a stated reason, and cannot touch billing or
          credentials.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3" action="/admin/users">
        <div>
          <label
            htmlFor="user-search"
            className="mb-1 block text-xs text-muted-foreground"
          >
            Search by email or name
          </label>
          <input
            id="user-search"
            name="search"
            defaultValue={searchParams?.search ?? ''}
            className="w-72 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label
            htmlFor="user-locked"
            className="mb-1 block text-xs text-muted-foreground"
          >
            Status
          </label>
          <select
            id="user-locked"
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
        title="All users"
        description={result.ok ? `${result.data.items.length} shown` : undefined}
      >
        {!result.ok ? (
          <PanelError result={result} />
        ) : result.data.items.length === 0 ? (
          <EmptyState message="No users match those filters." />
        ) : (
          <TableScroll>
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>User</Th>
                  <Th>Company</Th>
                  <Th>Last sign-in</Th>
                  <Th>Joined</Th>
                  <Th>State</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.data.items.map((user) => {
                  const membership = user.memberships[0];
                  const isPlatformAdmin = user.role === 'SUPER_ADMIN';

                  return (
                    <tr
                      key={user.id}
                      className={user.lockedAt ? 'bg-destructive/5' : undefined}
                    >
                      <Td>
                        <div className="font-medium">{user.email}</div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {user.name ? <span>{user.name}</span> : null}
                          {isPlatformAdmin ? (
                            <Badge variant="warning">SUPER_ADMIN</Badge>
                          ) : null}
                        </div>
                      </Td>
                      <Td>
                        {membership ? (
                          <div>
                            <div>{membership.company.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {membership.role}
                              {membership.company.lockedAt
                                ? ' · company locked'
                                : ''}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-muted-foreground">
                        {formatRelative(user.lastLoginAt)}
                      </Td>
                      <Td className="whitespace-nowrap text-muted-foreground">
                        {formatDate(user.createdAt)}
                      </Td>
                      <Td>
                        {user.lockedAt ? (
                          <div>
                            <Badge variant="destructive">Locked</Badge>
                            {user.lockedReason ? (
                              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                                {user.lockedReason}
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <Badge variant="success">Active</Badge>
                        )}
                      </Td>
                      <Td>
                        <div className="flex flex-col items-end gap-2">
                          <ImpersonateButton
                            userId={user.id}
                            email={user.email}
                            // Mirrors the server-side policy so the UI does not
                            // offer an action the API will refuse.
                            disabled={isPlatformAdmin || Boolean(user.lockedAt)}
                            disabledReason={
                              isPlatformAdmin
                                ? 'Admins cannot be impersonated'
                                : user.lockedAt
                                  ? 'Unlock before impersonating'
                                  : undefined
                            }
                          />
                          {isPlatformAdmin ? null : (
                            <LockToggle
                              subject="users"
                              id={user.id}
                              locked={Boolean(user.lockedAt)}
                              label={user.email}
                            />
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
