'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { navSections } from '@/lib/navigation';

interface SidebarNavProps {
  /** Invoked after a link is activated — lets the mobile sheet close itself. */
  onNavigate?: () => void;
  /**
   * Whether to render sections marked `superAdminOnly`.
   *
   * Presentation only. Every /admin route requires SUPER_ADMIN at the API, so a
   * user who types the URL still gets refused — this just stops advertising a
   * destination they cannot use. The flag existed before and was never read,
   * which meant every user saw the Platform section.
   */
  isSuperAdmin?: boolean;
}

export function SidebarNav({ onNavigate, isSuperAdmin = false }: SidebarNavProps) {
  const pathname = usePathname();

  const sections = navSections.filter(
    (section) => !section.superAdminOnly || isSuperAdmin,
  );

  return (
    <nav aria-label="Main" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {sections.map((section) => {
        const headingId = `nav-section-${section.label.toLowerCase()}`;
        return (
          <div key={section.label}>
            <h2
              id={headingId}
              className="px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-sidebar-muted"
            >
              {section.label}
            </h2>
            <ul aria-labelledby={headingId} className="space-y-1">
              {section.items.map((item) => {
                const isActive =
                  item.href === '/'
                    ? pathname === '/'
                    : pathname.startsWith(item.href);
                const Icon = item.icon;

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{item.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
