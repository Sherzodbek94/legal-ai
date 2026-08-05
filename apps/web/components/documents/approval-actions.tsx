'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import type { ApprovalActionState } from '@/app/(dashboard)/documents/[id]/actions';

type Action = (
  state: ApprovalActionState,
  formData: FormData,
) => Promise<ApprovalActionState>;

const INITIAL: ApprovalActionState = {};

const textareaClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm ' +
  'placeholder:text-muted-foreground focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

function Notice({ state }: { state: ApprovalActionState }) {
  if (!state.message) return null;

  return (
    <p
      role="status"
      className={`text-sm ${state.ok ? 'text-success' : 'text-destructive'}`}
    >
      {state.message}
    </p>
  );
}

function Submitting({
  children,
  variant,
  name,
  value,
}: {
  children: string;
  variant?: 'default' | 'destructive' | 'outline';
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant={variant} name={name} value={value} disabled={pending}>
      {pending ? 'Working…' : children}
    </Button>
  );
}

export function SubmitForApproval({ action }: { action: Action }) {
  const [state, formAction] = useFormState(action, INITIAL);

  return (
    <form action={formAction} className="space-y-3 px-5 py-4">
      <label htmlFor="note" className="block text-sm font-medium">
        Note for approvers
      </label>
      <textarea
        id="note"
        name="note"
        rows={2}
        maxLength={1000}
        className={textareaClass}
        placeholder="Optional context, recorded on the audit entry."
      />
      <Submitting>Submit for approval</Submitting>
      <Notice state={state} />
    </form>
  );
}

export function DecideApproval({ action }: { action: Action }) {
  const [state, formAction] = useFormState(action, INITIAL);

  return (
    <form action={formAction} className="space-y-3 px-5 py-4">
      <label htmlFor="comment" className="block text-sm font-medium">
        Comment
      </label>
      <textarea
        id="comment"
        name="comment"
        rows={2}
        maxLength={2000}
        className={textareaClass}
        placeholder="Required in practice for a rejection — the drafter needs to know what to fix."
      />
      <div className="flex flex-wrap gap-2">
        {/* Two submit buttons on one form, distinguished by the value they
            carry, so the comment applies to whichever decision is taken. */}
        <Submitting name="decision" value="APPROVE">
          Approve
        </Submitting>
        <Submitting name="decision" value="REJECT" variant="destructive">
          Reject
        </Submitting>
      </div>
      <Notice state={state} />
    </form>
  );
}
