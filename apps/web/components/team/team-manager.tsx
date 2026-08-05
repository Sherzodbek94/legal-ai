'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { apiBaseUrl } from '@/lib/api-config';
import { formatDate, formatRelative } from '@/lib/format';

export interface Member {
  id: string;
  role: string;
  joinedAt: string | null;
  user: {
    id: string;
    email: string;
    name: string | null;
    lastLoginAt: string | null;
    lockedAt: string | null;
  };
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
}

/** OWNER is absent deliberately — it is transferred, never assigned. */
const ASSIGNABLE_ROLES = ['ADMIN', 'ATTORNEY', 'PARALEGAL', 'VIEWER'] as const;

const ROLE_HELP: Record<string, string> = {
  ADMIN: 'Manages members and templates',
  ATTORNEY: 'Drafts and approves documents',
  PARALEGAL: 'Drafts documents',
  VIEWER: 'Read-only',
};

function roleTone(role: string) {
  return role === 'OWNER' ? 'default' : role === 'ADMIN' ? 'secondary' : 'outline';
}

/**
 * Team management.
 *
 * `canManage` gates the controls rather than the data: everyone in a company
 * can see who else is in it, but only an owner or admin can change it. The
 * real enforcement is `@Roles` on the API — this only avoids showing buttons
 * that would be refused.
 */
export function TeamManager({
  members,
  invitations,
  canManage,
  currentUserId,
}: {
  members: Member[];
  invitations: Invitation[];
  canManage: boolean;
  currentUserId: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('ATTORNEY');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Member | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function call(path: string, init: RequestInit): Promise<boolean> {
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        ...init,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const raw = body?.message;
        const message =
          typeof raw === 'string'
            ? raw
            : (raw?.message ?? 'Something went wrong. Please try again.');
        setError(message);
        return false;
      }
      return true;
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      return false;
    }
  }

  async function invite() {
    setSubmitting(true);
    setError(null);

    const ok = await call('/companies/members/invite', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim(), role }),
    });

    setSubmitting(false);
    if (!ok) return;

    toast(`Invitation sent to ${email.trim()}.`, 'success');
    setInviteOpen(false);
    setEmail('');
    router.refresh();
  }

  async function changeRole(member: Member, nextRole: string) {
    setBusyId(member.id);
    setError(null);

    const ok = await call(`/companies/members/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: nextRole }),
    });

    setBusyId(null);
    if (!ok) return;

    toast(`${member.user.email} is now ${nextRole.toLowerCase()}.`, 'success');
    router.refresh();
  }

  async function confirmRemove() {
    if (!pendingRemoval) return;
    setSubmitting(true);
    setError(null);

    const ok = await call(`/companies/members/${pendingRemoval.id}`, { method: 'DELETE' });

    setSubmitting(false);
    if (!ok) return;

    toast(`${pendingRemoval.user.email} removed.`, 'success');
    setPendingRemoval(null);
    router.refresh();
  }

  async function revoke(invitation: Invitation) {
    setBusyId(invitation.id);
    setError(null);

    const ok = await call(`/companies/members/invitations/${invitation.id}`, {
      method: 'DELETE',
    });

    setBusyId(null);
    if (!ok) return;

    toast('Invitation withdrawn.', 'success');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {members.length} member{members.length === 1 ? '' : 's'}
          {invitations.length > 0 ? `, ${invitations.length} pending` : ''}
        </p>
        {canManage ? (
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus aria-hidden="true" />
            Invite member
          </Button>
        ) : null}
      </div>

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last active</TableHead>
              {canManage ? <TableHead className="sr-only">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableEmpty colSpan={canManage ? 4 : 3} message="No members yet." />
            ) : (
              members.map((member) => {
                const isSelf = member.user.id === currentUserId;
                const isOwner = member.role === 'OWNER';
                // Neither is editable: the owner is transferred separately, and
                // demoting yourself can lock the company out of its own billing.
                const editable = canManage && !isOwner && !isSelf;

                return (
                  <TableRow key={member.id}>
                    <TableCell>
                      <span className="font-medium">{member.user.name ?? member.user.email}</span>
                      {member.user.name ? (
                        <span className="block text-xs text-muted-foreground">
                          {member.user.email}
                        </span>
                      ) : null}
                      {isSelf ? (
                        <span className="ml-1 text-xs text-muted-foreground">(you)</span>
                      ) : null}
                      {member.user.lockedAt ? (
                        <Badge variant="destructive" className="ml-2">
                          suspended
                        </Badge>
                      ) : null}
                    </TableCell>

                    <TableCell>
                      {editable ? (
                        <Select
                          aria-label={`Role for ${member.user.email}`}
                          value={member.role}
                          disabled={busyId === member.id}
                          onChange={(event) => void changeRole(member, event.target.value)}
                          className="h-8 w-36 py-1"
                        >
                          {ASSIGNABLE_ROLES.map((option) => (
                            <option key={option} value={option}>
                              {option.charAt(0) + option.slice(1).toLowerCase()}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Badge variant={roleTone(member.role)}>
                          {member.role.toLowerCase()}
                        </Badge>
                      )}
                    </TableCell>

                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {member.user.lastLoginAt ? formatRelative(member.user.lastLoginAt) : '—'}
                    </TableCell>

                    {canManage ? (
                      <TableCell className="text-right">
                        {editable ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${member.user.email}`}
                            onClick={() => setPendingRemoval(member)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                          </Button>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {invitations.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold">Pending invitations</h2>
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  {canManage ? <TableHead className="sr-only">Actions</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell className="font-medium">{invitation.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{invitation.role.toLowerCase()}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {invitation.expired ? (
                        <Badge variant="warning">expired</Badge>
                      ) : (
                        <span className="text-muted-foreground">
                          {formatDate(invitation.expiresAt)}
                        </span>
                      )}
                    </TableCell>
                    {canManage ? (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === invitation.id}
                          onClick={() => void revoke(invitation)}
                        >
                          Withdraw
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}

      {/* --- Invite ---------------------------------------------------------- */}
      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (!submitting) {
            setInviteOpen(open);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              They receive a single-use link. If they have no account yet, they
              set a password when they accept.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void invite();
            }}
          >
            <Field label="Email" htmlFor="invite-email" required>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>

            <Field label="Role" htmlFor="invite-role" hint={ROLE_HELP[role]} required>
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                {ASSIGNABLE_ROLES.map((option) => (
                  <option key={option} value={option}>
                    {option.charAt(0) + option.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => setInviteOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || !email.trim()}>
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  'Send invitation'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* --- Remove ---------------------------------------------------------- */}
      <Dialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) setPendingRemoval(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {pendingRemoval?.user.email}?</DialogTitle>
            <DialogDescription>
              They lose access immediately. Their documents, approvals, and audit
              history stay intact.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => setPendingRemoval(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={submitting}
              onClick={() => void confirmRemove()}
            >
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  Removing…
                </>
              ) : (
                'Remove'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
