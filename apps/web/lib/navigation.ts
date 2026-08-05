import {
  Building2,
  CreditCard,
  FileText,
  LayoutDashboard,
  LibraryBig,
  ScanLine,
  Search,
  Settings,
  ShieldAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
}

export interface NavSection {
  label: string;
  items: NavItem[];
  /** Rendered only for platform staff. Enforced in SidebarNav. */
  superAdminOnly?: boolean;
}

/**
 * Sidebar navigation.
 *
 * EVERY ENTRY HERE MUST RESOLVE TO A REAL PAGE. This list previously advertised
 * `/matters` and `/ai`, neither of which existed — five of eight links returned
 * 404, which is what a user experiences as a broken product rather than as an
 * unfinished one.
 *
 * Both were removed rather than stubbed:
 *   * `/matters` has no backend at all — there is no Matter model in the schema.
 *   * `/ai` has no persisted state; the AI engine returns a draft without saving
 *     it, so a page could only ever be a throwaway playground.
 *
 * When either gains a backend, add the link back alongside the page.
 */
export const navSections: NavSection[] = [
  {
    label: 'Workspace',
    items: [
      { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { title: 'Documents', href: '/documents', icon: FileText },
      { title: 'Templates', href: '/templates', icon: LibraryBig },
      { title: 'Scans', href: '/scans', icon: ScanLine },
      { title: 'Search', href: '/search', icon: Search },
    ],
  },
  {
    label: 'Administration',
    items: [
      { title: 'Companies', href: '/companies', icon: Building2 },
      { title: 'Team', href: '/team', icon: Users },
      { title: 'Billing', href: '/billing', icon: CreditCard },
      { title: 'Settings', href: '/settings', icon: Settings },
    ],
  },
  {
    label: 'Platform',
    superAdminOnly: true,
    items: [{ title: 'Administration', href: '/admin', icon: ShieldAlert }],
  },
];
