import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Wide tables scroll inside their own container, never the page body — a
 * horizontally scrolling `<body>` breaks the fixed sidebar layout.
 *
 * `tabIndex={0}` is what makes that scroll container reachable by keyboard;
 * a scrollable region with no focusable child is otherwise unreachable
 * without a pointer (WCAG 2.1.1).
 */
const Table = React.forwardRef<HTMLTableElement, React.ComponentPropsWithoutRef<'table'>>(
  ({ className, ...props }, ref) => (
    <div className="w-full overflow-x-auto" tabIndex={0}>
      <table ref={ref} className={cn('w-full caption-bottom', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.ComponentPropsWithoutRef<'thead'>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('border-b border-border', className)} {...props} />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.ComponentPropsWithoutRef<'tbody'>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('divide-y divide-border', className)} {...props} />
));
TableBody.displayName = 'TableBody';

const TableRow = React.forwardRef<HTMLTableRowElement, React.ComponentPropsWithoutRef<'tr'>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn('transition-colors hover:bg-muted/40', className)}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ComponentPropsWithoutRef<'th'>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    scope="col"
    className={cn(
      'whitespace-nowrap px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.ComponentPropsWithoutRef<'td'>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-4 py-3 align-middle text-sm', className)} {...props} />
));
TableCell.displayName = 'TableCell';

/** Shown in place of rows when a query legitimately returns nothing. */
function TableEmpty({ message, colSpan }: { message: string; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-5 py-10 text-center text-sm text-muted-foreground">
        {message}
      </td>
    </tr>
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty };
