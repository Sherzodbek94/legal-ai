'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, LockOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiBaseUrl } from '@/lib/api-config';

/**
 * Lock and unlock control for a user or a company.
 *
 * Locking demands a typed reason before the request is sent. That is not
 * ceremony: the reason is stored on the record and shown in the audit trail, and
 * the alternative is a support queue full of suspended accounts nobody can
 * explain months later.
 */
export function LockToggle({
  subject,
  id,
  locked,
  label,
}: {
  subject: 'users' | 'companies';
  id: string;
  locked: boolean;
  /** Name shown in the confirmation prompt. */
  label: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reasonTooShort = reason.trim().length < 10;

  async function send(method: 'POST' | 'DELETE', body?: unknown) {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/admin/${subject}/${id}/lock`, {
        method,
        // The access token is an HTTPOnly cookie on the API's origin; without
        // this the request is anonymous and the API answers 401.
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.message ?? `Request failed (${response.status})`);
        return;
      }

      setShowForm(false);
      setReason('');
      // Re-fetch the server component so the row reflects the new state rather
      // than being patched locally and drifting from the source of truth.
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  if (locked) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || isPending}
          onClick={() => void send('DELETE')}
        >
          <LockOpen aria-hidden="true" />
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (!showForm) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowForm(true)}
        aria-label={`Lock ${label}`}
      >
        <Lock aria-hidden="true" />
        Lock
      </Button>
    );
  }

  return (
    <form
      className="flex flex-col items-stretch gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reasonTooShort) void send('POST', { reason: reason.trim() });
      }}
    >
      <label className="text-xs text-muted-foreground" htmlFor={`reason-${id}`}>
        Reason for locking {label}
      </label>
      <input
        id={`reason-${id}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="At least 10 characters"
        className="w-56 rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setShowForm(false);
            setReason('');
            setError(null);
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="destructive"
          size="sm"
          disabled={reasonTooShort || busy}
        >
          {busy ? 'Locking…' : 'Confirm lock'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
