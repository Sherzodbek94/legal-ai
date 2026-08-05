import Link from 'next/link';
import { AcceptInvitationForm } from '@/components/team/accept-invitation-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiBaseUrl } from '@/lib/api-config';

export const metadata = { title: 'Join a workspace' };

interface InvitationPreview {
  companyName: string;
  email: string;
  role: string;
  hasAccount: boolean;
}

/**
 * Public, and outside the `(dashboard)` group.
 *
 * The invitee has no session and usually no account — the token in the URL is
 * the only credential. `middleware.ts` lets `/invitations/*` through
 * unauthenticated for exactly this reason.
 *
 * Fetched directly rather than through `lib/api`'s `apiGet`, which forwards
 * the caller's session cookie; there is no session here to forward.
 */
async function loadInvitation(token: string): Promise<InvitationPreview | null> {
  try {
    const response = await fetch(`${apiBaseUrl}/invitations/${encodeURIComponent(token)}`, {
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return (await response.json()) as InvitationPreview;
  } catch {
    return null;
  }
}

export default async function InvitationPage({
  params,
}: {
  params: { token: string };
}) {
  const invitation = await loadInvitation(params.token);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">LegalTech AI</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {invitation ? 'You have been invited' : 'Invitation'}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          {invitation ? (
            <AcceptInvitationForm
              token={params.token}
              companyName={invitation.companyName}
              email={invitation.email}
              hasAccount={invitation.hasAccount}
            />
          ) : (
            <div className="space-y-4">
              {/*
                One message for every unusable state — expired, already used,
                withdrawn, or never real. The API answers uniformly for the same
                reason: distinguishing them tells a guesser which tokens existed.
              */}
              <Alert variant="warning" title="This invitation is no longer valid">
                It may have expired, already been used, or been withdrawn. Ask
                whoever invited you to send a new one.
              </Alert>
              <Button asChild variant="outline" className="w-full">
                <Link href="/login">Go to sign in</Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
