'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { apiBaseUrl } from '@/lib/api-config';
import { formatCentsExact } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PlanView {
  id: string;
  name: string;
  monthlyPriceCents: number;
  currency: string;
  trialDays: number;
  features: Record<string, boolean>;
}

const FEATURE_LABELS: Record<string, string> = {
  aiGeneration: 'AI drafting',
  approvalWorkflows: 'Approval workflows',
  customTemplates: 'Custom templates',
  apiAccess: 'API access',
  prioritySupport: 'Priority support',
  whiteLabelExports: 'Unwatermarked exports',
};

/**
 * Plan selection.
 *
 * The billing page previously stated plainly that changing plans was "not
 * yet available from this screen" — `POST /billing/subscription` existed and
 * was tested, with nothing calling it.
 *
 * Every change goes through a confirmation dialog naming the direction and
 * its effective date, because the two cases behave differently and the
 * difference is money: an upgrade applies immediately, a downgrade is
 * deferred to the end of the period the customer has already paid for.
 */
export function PlanPicker({
  plans,
  currentPlan,
  isOwner,
}: {
  plans: PlanView[];
  currentPlan: string;
  isOwner: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<PlanView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentIndex = plans.findIndex((plan) => plan.id === currentPlan);

  async function confirm() {
    if (!pending) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/billing/subscription`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: pending.id }),
      });

      if (!response.ok) {
        const parsed = await response.json().catch(() => null);
        setError(parsed?.message ?? 'Could not change your plan. Please try again.');
        setSubmitting(false);
        return;
      }

      toast(`Switched to ${pending.name}.`, 'success');
      setPending(null);
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const pendingIndex = pending ? plans.findIndex((plan) => plan.id === pending.id) : -1;
  const isDowngrade = pendingIndex > -1 && currentIndex > -1 && pendingIndex < currentIndex;

  return (
    <>
      <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = plan.id === currentPlan;
          const included = Object.entries(plan.features).filter(([, on]) => on);

          return (
            <div
              key={plan.id}
              className={cn(
                'flex flex-col rounded-lg border p-4',
                isCurrent ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold">{plan.name}</h3>
                {isCurrent ? <Badge>Current</Badge> : null}
              </div>

              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {plan.monthlyPriceCents === 0
                  ? 'Free'
                  : formatCentsExact(plan.monthlyPriceCents, plan.currency.toUpperCase())}
                {plan.monthlyPriceCents > 0 ? (
                  <span className="text-sm font-normal text-muted-foreground">/mo</span>
                ) : null}
              </p>

              {plan.trialDays > 0 && !isCurrent ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {plan.trialDays}-day trial
                </p>
              ) : null}

              <ul className="mt-3 flex-1 space-y-1.5">
                {included.map(([key]) => (
                  <li key={key} className="flex items-start gap-2 text-xs">
                    <Check
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <span>{FEATURE_LABELS[key] ?? key}</span>
                  </li>
                ))}
              </ul>

              <Button
                className="mt-4 w-full"
                variant={isCurrent ? 'outline' : 'default'}
                disabled={isCurrent || !isOwner}
                onClick={() => {
                  setError(null);
                  setPending(plan);
                }}
              >
                {isCurrent ? 'Current plan' : `Switch to ${plan.name}`}
              </Button>
            </div>
          );
        })}
      </div>

      {!isOwner ? (
        <div className="px-5 pb-4">
          <Alert>
            Only the company owner can change the subscription.
          </Alert>
        </div>
      ) : null}

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) {
            setPending(null);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isDowngrade ? 'Downgrade' : 'Switch'} to {pending?.name}?
            </DialogTitle>
            <DialogDescription>
              {isDowngrade
                ? 'Your current plan stays active until the end of the period you have already paid for. The change applies at renewal.'
                : 'This takes effect immediately. Your next renewal will be charged at the new rate.'}
            </DialogDescription>
          </DialogHeader>

          {pending && pending.monthlyPriceCents > 0 ? (
            <p className="text-sm">
              <span className="font-medium">
                {formatCentsExact(
                  pending.monthlyPriceCents,
                  pending.currency.toUpperCase(),
                )}
              </span>{' '}
              per month.
            </p>
          ) : null}

          {error ? (
            <Alert variant="destructive" className="mt-3">
              {error}
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
            <Button disabled={submitting} onClick={() => void confirm()}>
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  Applying…
                </>
              ) : (
                'Confirm'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
