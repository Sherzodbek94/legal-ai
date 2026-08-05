import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A labelled form control with inline validation messaging.
 *
 * Wraps the three things that have to agree with each other and previously
 * did not: the `<label for>`, the control's `aria-describedby`, and where the
 * error text actually renders. Passing an `error` here is what makes a form
 * say *which* field is wrong instead of showing one message at the bottom —
 * which is what every form in this app used to do.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const errorId = error ? `${htmlFor}-error` : undefined;
  const hintId = hint ? `${htmlFor}-hint` : undefined;

  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="ml-0.5 text-destructive">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </label>

      {/*
        The control is cloned rather than wrapped so the wiring lands on the
        real input: describedby has to point at the message from the element
        the screen reader is focused on, not from a parent div.
      */}
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: htmlFor,
            'aria-invalid': error ? true : undefined,
            'aria-describedby':
              [errorId, hintId].filter(Boolean).join(' ') || undefined,
            required,
          })
        : children}

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
