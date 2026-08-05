import { Alert } from '@/components/ui/alert';
import {
  TeamManager,
  type Invitation,
  type Member,
} from '@/components/team/team-manager';
import { apiGet } from '@/lib/api';
import { getSession } from '@/lib/session';

export const metadata = { title: 'Team' };

interface MembersResponse {
  members: Member[];
  invitations: Invitation[];
}

/**
 * Who belongs to this workspace.
 *
 * Until the membership API existed there was no way to add a second person to
 * a company at all — which made the approval chains unusable, since a document
 * cannot be approved by whoever submitted it.
 */
export default async function TeamPage() {
  const [data, session] = await Promise.all([
    apiGet<MembersResponse>('/companies/members'),
    getSession(),
  ]);

  const canManage =
    session.user?.companyRole === 'OWNER' || session.user?.companyRole === 'ADMIN';

  return (
    <div className="mx-auto w-full max-w-4xl animate-rise-in space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          People with access to this workspace. Approval chains need at least two
          — a document cannot be approved by whoever submitted it.
        </p>
      </div>

      {!data.ok ? (
        <Alert variant="destructive" title="Could not load your team">
          {data.status > 0 ? `${data.status}: ` : ''}
          {data.message}
        </Alert>
      ) : (
        <TeamManager
          members={data.data.members}
          invitations={data.data.invitations}
          canManage={canManage}
          currentUserId={session.user?.id ?? null}
        />
      )}
    </div>
  );
}
