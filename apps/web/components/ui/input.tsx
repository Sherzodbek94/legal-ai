import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The single source of truth for text-input styling.
 *
 * This string was previously copy-pasted into four separate form components,
 * which is how a focus ring ends up looking different on the login page than
 * on the one right after it.
 *
 * `aria-invalid` drives the error styling rather than a separate `error`
 * prop: the attribute has to be on the element anyway for screen readers,
 * and keying the colour off it means the two can never disagree.
 */
export const inputClassName = cn(
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
  'placeholder:text-muted-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'disabled:cursor-not-allowed disabled:opacity-60',
  'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive',
);

const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<'input'>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(inputClassName, className)} {...props} />
  ),
);
Input.displayName = 'Input';

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentPropsWithoutRef<'textarea'>
>(({ className, rows = 3, ...props }, ref) => (
  <textarea ref={ref} rows={rows} className={cn(inputClassName, className)} {...props} />
));
Textarea.displayName = 'Textarea';

/**
 * A native `<select>`, deliberately.
 *
 * A custom listbox would need keyboard handling, typeahead, portalling, and
 * scroll containment reimplemented to match what the platform already does
 * correctly — and on mobile the native picker is the better experience by a
 * wide margin.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentPropsWithoutRef<'select'>
>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(inputClassName, 'pr-8', className)} {...props} />
));
Select.displayName = 'Select';

export { Input, Textarea, Select };
