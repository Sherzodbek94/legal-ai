'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBaseUrl } from '@/lib/api-config';

/**
 * Accepts an invitation.
 *
 * Two shapes behind one form. When the invited address already has an account
 * there is nothing to collect — accepting just attaches the membership, and
 * they sign in as they always did. When it does not, this is also the account
 * creation step, so it asks for a password.
 *
 * No session is minted either way: they land on `/login` afterwards, which
 * keeps one path into an authenticated session rather than two.
 */
export function AcceptInvitationForm({
  token,
  companyName,
  email,
  hasAccount,
}: {
  token: string;
  companyName: string;
  email: string;
  hasAccount: boolean;
}) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    if (!hasAccount && password.length < 12) {
      setFieldError('Password must be at least 12 characters.');
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch(`${apiBaseUrl}/invitations/${token}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          hasAccount ? {} : { password, ...(name.trim() ? { name: name.trim() } : {}) },
        ),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const raw = body?.message;
        setError(
          typeof raw === 'string'
            ? raw
            : (raw?.message ??
                'This invitation could not be accepted. It may have expired.'),
        );
        setSubmitting(false);
        return;
      }

      window.location.href = '/login?joined=1';
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <Alert>
        You were invited to join <strong>{companyName}</strong> as{' '}
        <strong>{email}</strong>.
      </Alert>

      {!hasAccount ? (
        <>
          <Field label="Your name" htmlFor="accept-name">
            <Input
              type="text"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nilufar Tosheva"
            />
          </Field>

          <Field
            label="Choose a password"
            htmlFor="accept-password"
            error={fieldError ?? undefined}
            hint="At least 12 characters."
            required
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          This address already has an account. Accepting adds {companyName} to it —
          sign in with your existing password afterwards.
        </p>
      )}

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? (
          <>
            <Loader2 className="animate-spin" aria-hidden="true" />
            Joining…
          </>
        ) : (
          `Join ${companyName}`
        )}
      </Button>
    </form>
  );
}
