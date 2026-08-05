import Link from 'next/link';
import { Search, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { MobileNav } from './mobile-nav';
import { NotificationsMenu } from './notifications-menu';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { getSession } from '@/lib/session';

export async function Header() {
  // Deduped by React cache — the layout and sidebar read the same result.
  const session = await getSession();

  return (
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
      <MobileNav isSuperAdmin={session.isSuperAdmin} />

      <Separator orientation="vertical" className="hidden h-6 lg:block" />

      <WorkspaceSwitcher
        companyName={session.company?.name ?? session.company?.legalName ?? null}
      />

      {/*
        Impersonation banner. A support engineer acting inside a customer's
        account must never be able to forget it — every action is attributed to
        them in the audit log, and mistaking whose account this is is exactly how
        an operator does something to the wrong tenant.
      */}
      {session.isImpersonating ? (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5">
          <ShieldAlert
            className="h-4 w-4 shrink-0 text-warning-foreground"
            aria-hidden="true"
          />
          <span className="truncate text-xs font-medium text-warning-foreground">
            Impersonating {session.user?.email}
          </span>
        </div>
      ) : null}

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="Search">
          <Link href="/search">
            <Search className="h-5 w-5" aria-hidden="true" />
          </Link>
        </Button>
        <ThemeToggle />
        <NotificationsMenu />
        <Separator orientation="vertical" className="mx-1 h-6" />
        <UserMenu email={session.user?.email ?? null} />
      </div>
    </header>
  );
}
