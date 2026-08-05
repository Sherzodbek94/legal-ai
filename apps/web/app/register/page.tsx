import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RegisterForm } from '@/components/auth/register-form';
import { getAuthProviders } from '@/lib/auth-providers';
import { getSession } from '@/lib/session';

export const metadata = { title: 'Create your account' };

/**
 * Outside the `(dashboard)` route group, same reasoning as `/login`: it
 * renders without the sidebar/header shell, which assumes a signed-in user
 * with a company — and this page exists for people who have neither yet.
 */
export default async function RegisterPage() {
  const session = await getSession();
  if (session.user) {
    redirect(session.company || session.isSuperAdmin ? '/dashboard' : '/onboarding');
  }

  const providers = await getAuthProviders();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Next, you&rsquo;ll set up your company workspace.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <RegisterForm providers={providers} />
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
