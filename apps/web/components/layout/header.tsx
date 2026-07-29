import { Bell, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { MobileNav } from './mobile-nav';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';

export function Header() {
  return (
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
      <MobileNav />

      <Separator orientation="vertical" className="hidden h-6 lg:block" />

      <WorkspaceSwitcher />

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <Button variant="ghost" size="icon" aria-label="Search">
          <Search className="h-5 w-5" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Notifications">
          <Bell className="h-5 w-5" aria-hidden="true" />
        </Button>
        <Separator orientation="vertical" className="mx-1 h-6" />
        <UserMenu />
      </div>
    </header>
  );
}
