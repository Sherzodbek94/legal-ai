import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { getAuthProviders } from '@/lib/auth-providers';
import { getSession } from '@/lib/session';

export const metadata = { title: 'Sign in' };

/**
 * Outside the `(dashboard)` route group deliberately: it renders without the
 * sidebar/header shell, which assumes a signed-in user with a company.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const next =
    searchParams?.next && searchParams.next.startsWith('/')
      ? searchParams.next
      : '/dashboard';

  // Already signed in — most likely someone followed a stale bookmark or
  // hit back after logging in. Land them where they were headed rather than
  // showing a form there is nothing to submit.
  const session = await getSession();
  if (session.user) {
    redirect(next);
  }

  const providers = await getAuthProviders();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">LegalTech AI</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to your workspace
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <LoginForm next={next} providers={providers} />
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Access is provisioned by your company owner or platform administrator.
        </p>
      </div>
    </div>
  );
}
