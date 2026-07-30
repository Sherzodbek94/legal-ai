import {
  Bot,
  Building2,
  CreditCard,
  FileText,
  LayoutDashboard,
  Scale,
  Settings,
  ShieldAlert,
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
  /** Sections only platform staff should see listed. */
  superAdminOnly?: boolean;
}

export const navSections: NavSection[] = [
  {
    label: 'Workspace',
    items: [
      { title: 'Dashboard', href: '/', icon: LayoutDashboard },
      { title: 'Matters', href: '/matters', icon: Scale },
      { title: 'Documents', href: '/documents', icon: FileText },
    ],
  },
  {
    label: 'Intelligence',
    items: [{ title: 'AI Analysis', href: '/ai', icon: Bot }],
  },
  {
    label: 'Administration',
    items: [
      { title: 'Companies', href: '/companies', icon: Building2 },
      { title: 'Billing', href: '/billing', icon: CreditCard },
      { title: 'Settings', href: '/settings', icon: Settings },
    ],
  },
  {
    label: 'Platform',
    /**
     * Visible only to platform staff.
     *
     * Hiding the link is presentation, not access control — every /admin route
     * requires SUPER_ADMIN at the API, so a user who types the URL gets panels
     * reporting 403 rather than data.
     */
    superAdminOnly: true,
    items: [{ title: 'Administration', href: '/admin', icon: ShieldAlert }],
  },
];

export interface Workspace {
  id: string;
  name: string;
  plan: string;
}

export const workspaces: Workspace[] = [
  { id: 'acme-legal', name: 'Acme Legal LLP', plan: 'Professional' },
  { id: 'harbor-counsel', name: 'Harbor Counsel', plan: 'Starter' },
  { id: 'meridian-group', name: 'Meridian Group', plan: 'Enterprise' },
];
