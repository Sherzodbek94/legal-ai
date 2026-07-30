import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';

const tabs = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/companies', label: 'Companies' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/ai-costs', label: 'AI costs' },
  { href: '/admin/audit', label: 'Audit log' },
];

/**
 * Admin section shell.
 *
 * The banner is not decoration. Every page under here reads across all tenants,
 * and an operator who forgets which context they are in is how one customer's
 * data ends up quoted to another.
 *
 * Access is enforced by the API — every /admin route requires SUPER_ADMIN — so
 * a non-admin reaching this URL sees panels reporting 403 rather than data. The
 * navigation entry is hidden for them, but hiding a link is presentation, not a
 * control.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
        <ShieldAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground"
          aria-hidden="true"
        />
        <p className="text-sm text-warning-foreground">
          <span className="font-semibold">Platform administration.</span> These
          pages span every tenant. Actions here are recorded in the audit log
          against your account.
        </p>
      </div>

      <nav aria-label="Administration" className="mb-8 border-b border-border">
        <ul className="-mb-px flex flex-wrap gap-1">
          {tabs.map((tab) => (
            <li key={tab.href}>
              <Link
                href={tab.href}
                className="inline-block border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {children}
    </div>
  );
}
