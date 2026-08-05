'use client';

import { useState, type FormEvent } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Divider } from './divider';
import { GoogleButton } from './google-button';
import { OneIdButton } from './oneid-button';
import { PhoneSignIn } from './phone-sign-in';
import { apiBaseUrl } from '@/lib/api-config';
import { useHydrated } from '@/lib/use-hydrated';
import { readApiError } from '@/lib/read-api-error';
import type { AuthProviders } from '@/lib/auth-providers';

/**
 * Account creation only — not company creation. `POST /auth/register` gives
 * the caller a `User` and a session, nothing more; there is no company to
 * belong to yet, and no role to hold in one. `/onboarding`, right after this,
 * is what makes them the owner of something. Splitting it this way is what
 * lets the exact same onboarding step also serve a first-time OneID sign-in,
 * which never goes through this form at all.
 */
export function RegisterForm({ providers }: { providers: AuthProviders }) {
  const hydrated = useHydrated();
  const [mode, setMode] = useState<'password' | 'phone'>('password');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);

  const hasAlternatives = providers.sms || providers.google || providers.oneid;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/register`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      });

      if (!response.ok) {
        setError(
          response.status === 409
            ? 'An account with that email already exists.'
            : // The API nests validation detail one level deeper than its
              // top-level message; without this unwrapping the user sees only
              // "Unprocessable Entity" for a password that is simply too short.
              await readApiError(
                response,
                'Could not create your account. Please try again.',
              ),
        );
        setShake((n) => n + 1);
        setSubmitting(false);
        return;
      }

      // Full navigation, same reasoning as login: the next page's server
      // components need a fresh request carrying the cookie just issued.
      window.location.href = '/onboarding';
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  if (mode === 'phone') {
    return <PhoneSignIn onCancel={() => setMode('password')} />;
  }

  return (
    <div className="animate-fade-in space-y-6">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field label="Your name" htmlFor="name">
          <Input
            type="text"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Aziz Karimov"
          />
        </Field>

        <Field label="Email" htmlFor="email" required>
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.uz"
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          hint="At least 12 characters."
          error={error ?? undefined}
          required
        >
          <Input
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            // Changing key restarts the animation, so a second failure plays
            // it again instead of nothing.
            key={`pw-${shake}`}
            className={error ? 'animate-shake' : undefined}
          />
        </Field>

        <Button type="submit" disabled={submitting || !hydrated} className="w-full">
          {submitting ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Creating account…
            </>
          ) : (
            'Create account'
          )}
        </Button>
      </form>

      {/* Offered here as well as on sign-in: a first-time user is exactly who
          benefits from not having to invent and remember a password, and each
          of these provisions the account on its own. */}
      {hasAlternatives ? (
        <>
          <Divider>or</Divider>

          <div className="space-y-2">
            {providers.sms ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => setMode('phone')}
              >
                <MessageSquare aria-hidden="true" />
                Continue with SMS code
              </Button>
            ) : null}

            {providers.google ? <GoogleButton /> : null}
            {providers.oneid ? <OneIdButton /> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
