import { cn } from '@/lib/utils';

/**
 * Placeholder shown while a route's data is still loading.
 *
 * `animate-pulse` is dropped under `prefers-reduced-motion` — a pulsing
 * block is exactly the kind of repetitive motion that guideline exists for,
 * and the skeleton still reads correctly without it.
 */
export function Skeleton({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-md bg-muted motion-safe:animate-pulse',
        className,
      )}
      {...props}
    />
  );
}

/** A skeleton shaped like the table rows it stands in for. */
export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-border" aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn('h-4', columnIndex === 0 ? 'w-1/3' : 'flex-1')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Matches the StatCard grid, so the layout does not jump when data lands. */
export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-lg border border-border bg-card p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-8 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * The whole-page fallback used by `loading.tsx`.
 *
 * Announced politely rather than silently: a sighted user sees the skeleton,
 * and without this a screen-reader user gets nothing at all between
 * navigating and the content arriving.
 */
export function PageSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6 lg:px-8"
    >
      <span className="sr-only">Loading…</span>
      <div>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <SkeletonStats />
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <Skeleton className="h-4 w-32" />
        </div>
        <SkeletonTable />
      </div>
    </div>
  );
}
