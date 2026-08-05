import Link from 'next/link';
import { Scale } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SidebarBrand({ className }: { className?: string }) {
  return (
    <Link
      href="/dashboard"
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sidebar-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
      >
        <Scale className="h-4 w-4" />
      </span>
      <span className="text-sm font-semibold tracking-tight">LegalTech AI</span>
    </Link>
  );
}
