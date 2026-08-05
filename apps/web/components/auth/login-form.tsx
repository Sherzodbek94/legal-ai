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
import type { AuthProviders } from '@/lib/auth-providers';

/**
 * Only ever a same-origin path. `next` comes from a query parameter an
 * attacker controls, and blindly navigating to it would make this page an
 * open redirect — e.g. `/login?next=https://evil.example`.
 */
function safeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

/**
 * Sign-in.
 *
 * Password is the default because it is what a returning user of this product
 * most often has. Phone replaces the form in place rather than opening a
 * separate page — the alternatives are alternatives, not a journey.
 *
 * `providers` decides which alternatives exist at all; see `getAuthProviders`.
 */
export function LoginForm({
  next,
  providers,
}: {
  next: string;
  providers: AuthProviders;
}) {
  const hydrated = useHydrated();
  const [mode, setMode] = useState<'password' | 'phone'>('password');
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
      // Talks to the API's own origin, not a Next.js route — the HTTPOnly
      // cookies it sets are readable there and nowhere else. `credentials:
      // 'include'` is what makes the browser store them from a cross-origin
      // response, and CORS on the API allows exactly this origin with
      // credentials for that reason (see main.ts).
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(
          response.status === 401
            ? 'Incorrect email or password.'
            : (body?.message ?? 'Could not sign in. Please try again.'),
        );
        setShake((n) => n + 1);
        setSubmitting(false);
        return;
      }

      // A full navigation, not client-side routing: every server component
      // downstream reads the session from the request it receives, and only a
      // fresh request carries the cookie the browser just stored.
      window.location.href = safeNext(next);
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
        <Field label="Email" htmlFor="email" required>
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="owner@acme-legal.uz"
          />
        </Field>

        <Field label="Password" htmlFor="password" error={error ?? undefined} required>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            // Restarts the animation on every failure — without a changing
            // key a second wrong password plays nothing.
            key={`pw-${shake}`}
            className={error ? 'animate-shake' : undefined}
          />
        </Field>

        <Button
          type="submit"
          disabled={submitting || !hydrated}
          className="w-full"
        >
          {submitting ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Signing in…
            </>
          ) : (
            'Sign in'
          )}
        </Button>
      </form>

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
                Sign in with SMS code
              </Button>
            ) : null}

            {providers.google ? <GoogleButton label="Sign in with Google" /> : null}
            {providers.oneid ? <OneIdButton /> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
