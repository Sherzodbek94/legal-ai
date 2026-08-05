import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'flex items-start gap-3 rounded-md border px-4 py-3 text-sm',
  {
    variants: {
      variant: {
        info: 'border-border bg-muted/50 text-foreground',
        success: 'border-success/30 bg-success/10 text-foreground',
        warning: 'border-warning/40 bg-warning/10 text-foreground',
        destructive: 'border-destructive/30 bg-destructive/10 text-foreground',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
} as const;

const ICON_TONE = {
  info: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
} as const;

export interface AlertProps
  extends React.ComponentPropsWithoutRef<'div'>,
    VariantProps<typeof alertVariants> {
  title?: string;
}

/**
 * An inline message attached to a region of the page.
 *
 * `role` follows severity rather than being fixed: an error a user needs to
 * act on interrupts, while a success confirmation should not talk over
 * whatever they are reading next.
 */
export function Alert({
  className,
  variant = 'info',
  title,
  children,
  ...props
}: AlertProps) {
  const resolved = variant ?? 'info';
  const Icon = ICONS[resolved];

  return (
    <div
      role={resolved === 'destructive' ? 'alert' : 'status'}
      className={cn(alertVariants({ variant: resolved }), className)}
      {...props}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', ICON_TONE[resolved])} aria-hidden="true" />
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? (
          <div className={cn('text-muted-foreground', title && 'mt-0.5')}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}
