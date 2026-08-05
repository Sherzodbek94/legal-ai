import { redirect } from 'next/navigation';
import { OnboardingForm } from '@/components/auth/onboarding-form';
import { getSession } from '@/lib/session';

export const metadata = { title: 'Set up your company' };

/**
 * Outside the `(dashboard)` route group: it is reached precisely because the
 * session has no company yet, and the dashboard shell assumes one on every
 * page. Requires authentication (middleware still redirects an anonymous
 * visitor to `/login`) but not a company — that is the one thing this page
 * exists to create.
 */
export default async function OnboardingPage() {
  const session = await getSession();

  if (!session.user) {
    redirect('/login');
  }
  if (session.company || session.isSuperAdmin) {
    redirect('/dashboard');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Set up your company</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One workspace per account. You&rsquo;ll be its owner.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <OnboardingForm />
        </div>
      </div>
    </div>
  );
}
