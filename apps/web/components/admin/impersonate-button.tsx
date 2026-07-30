'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiBaseUrl } from '@/lib/api-config';

/**
 * Starts a 15-minute impersonation session.
 *
 * The typed justification is mandatory and is stored on the session record — an
 * impersonation with no stated reason is indistinguishable from snooping when it
 * is reviewed later.
 *
 * On success the API replaces the access cookie, so the operator's *next*
 * navigation is already as the target user. The full reload is deliberate:
 * every cached server component was rendered under the old identity and must be
 * discarded rather than reused across an identity change.
 */
export function ImpersonateButton({
  userId,
  email,
  disabled,
  disabledReason,
}: {
  userId: string;
  email: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reasonTooShort = reason.trim().length < 10;

  if (disabled) {
    return (
      <span className="text-xs text-muted-foreground" title={disabledReason}>
        {disabledReason ?? 'Unavailable'}
      </span>
    );
  }

  async function start() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/admin/impersonation`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: userId, reason: reason.trim() }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.message ?? `Request failed (${response.status})`);
        return;
      }

      // Hard navigation, not router.push: the identity behind every subsequent
      // request has changed and nothing rendered under the previous one is safe
      // to keep.
      window.location.href = '/';
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  if (!showForm) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowForm(true)}
        aria-label={`Impersonate ${email}`}
      >
        <UserCog aria-hidden="true" />
        Impersonate
      </Button>
    );
  }

  return (
    <form
      className="flex flex-col items-stretch gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reasonTooShort) void start();
      }}
    >
      <label
        className="text-xs text-muted-foreground"
        htmlFor={`impersonate-reason-${userId}`}
      >
        Justification — recorded against this session
      </label>
      <input
        id={`impersonate-reason-${userId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="e.g. Ticket #4412, PDF export failing"
        className="w-64 rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        autoFocus
      />
      <p className="text-xs text-muted-foreground">
        Session lasts 15 minutes. Billing and credential changes stay blocked.
      </p>
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
        <Button type="submit" size="sm" disabled={reasonTooShort || busy}>
          {busy ? 'Starting…' : 'Start session'}
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

/** Ends an active session from the admin list. */
export function EndImpersonationButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function end() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `${apiBaseUrl}/admin/impersonation/${sessionId}`,
        { method: 'DELETE', credentials: 'include' },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.message ?? `Request failed (${response.status})`);
        return;
      }

      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void end()}>
        {busy ? 'Ending…' : 'End session'}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
