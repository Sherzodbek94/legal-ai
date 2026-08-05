import { redirect } from 'next/navigation';
import { Header } from './header';
import { Sidebar } from './sidebar';
import { getSession } from '@/lib/session';

export async function AppShell({ children }: { children: React.ReactNode }) {
  // Deduped with the Header's own call by React's `cache()` — one request, not
  // two.
  const session = await getSession();

  // Middleware already redirects when the cookie is missing entirely; this
  // catches the case it cannot — a cookie that is present but expired or
  // revoked, which only `/auth/me` (inside getSession) can detect.
  if (!session.user) {
    redirect('/login');
  }

  // A signed-in user with no company has nothing this shell can render —
  // every panel here scopes to a tenant. Platform administrators are the one
  // exception: `SUPER_ADMIN` is a platform role, not a tenant membership, and
  // is never expected to have a company of their own.
  if (!session.company && !session.isSuperAdmin) {
    redirect('/onboarding');
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar isSuperAdmin={session.isSuperAdmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto focus:outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
