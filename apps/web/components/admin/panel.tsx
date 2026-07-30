import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ApiResult } from '@/lib/api';

/** A titled card, the unit every admin page is built from. */
export function Panel({
  title,
  description,
  action,
  className,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const headingId = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <section
      aria-labelledby={headingId}
      className={cn('rounded-lg border border-border bg-card', className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 id={headingId} className="text-sm font-semibold tracking-tight">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * Rendered in place of a panel whose data failed to load.
 *
 * Scoped to the panel rather than the page: one unreachable endpoint should not
 * hide the five that answered.
 */
export function PanelError({ result }: { result: { status: number; message: string } }) {
  return (
    <div className="flex items-start gap-3 px-5 py-6 text-sm">
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
        aria-hidden="true"
      />
      <div>
        <p className="font-medium text-foreground">Could not load this panel</p>
        <p className="mt-0.5 text-muted-foreground">
          {result.status > 0 ? `${result.status}: ` : ''}
          {result.message}
        </p>
      </div>
    </div>
  );
}

/** Narrows an ApiResult at the call site, so pages read as data-or-error. */
export function unwrap<T>(result: ApiResult<T>): T | null {
  return result.ok ? result.data : null;
}

export function EmptyState({ message }: { message: string }) {
  return (
    <p className="px-5 py-8 text-center text-sm text-muted-foreground">{message}</p>
  );
}

/** A single headline figure. */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'positive' | 'negative' | 'warning';
}) {
  const toneClass = {
    default: 'text-card-foreground',
    positive: 'text-success',
    negative: 'text-destructive',
    warning: 'text-warning',
  }[tone];

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-2 text-2xl font-semibold tracking-tight tabular-nums',
          toneClass,
        )}
      >
        {value}
      </dd>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * A horizontally scrollable table wrapper.
 *
 * Admin tables are wide by nature. Scrolling the table inside its own container
 * keeps the page body from scrolling sideways, which breaks the sidebar layout.
 */
export function TableScroll({ children }: { children: React.ReactNode }) {
  return <div className="w-full overflow-x-auto">{children}</div>;
}

export function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={cn('px-4 py-3 align-middle text-sm', className)}>{children}</td>
  );
}
