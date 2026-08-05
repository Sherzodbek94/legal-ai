'use client';

import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiBaseUrl } from '@/lib/api-config';

/**
 * Starts the OneID (id.egov.uz) redirect.
 *
 * Extracted from the login form so both `/login` and `/register` offer it
 * from the same component — the two pages used to build the same fetch twice,
 * and only one of them handled the not-configured case.
 *
 * Whether it renders at all is decided server-side from `/auth/providers` — see
 * `getAuthProviders`. The self-hiding below is the leftover case that check
 * cannot cover: credentials removed between the page render and the click.
 */
export function OneIdButton({ label = 'Continue with OneID' }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  if (unavailable) return null;

  async function start() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/oneid/authorize`, {
        credentials: 'include',
      });

      // 500 as well as 503: `getOrThrow` on an unset client id surfaces as an
      // internal error rather than a service-unavailable, and either way the
      // provider is simply not set up here.
      if (response.status === 503 || response.status === 500) {
        setUnavailable(true);
        return;
      }
      if (!response.ok) throw new Error();

      const { url } = (await response.json()) as { url: string };
      window.location.href = url;
    } catch {
      setError('OneID sign-in is not available right now.');
      setBusy(false);
    }
  }

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={busy}
        onClick={() => void start()}
      >
        {busy ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <ShieldCheck aria-hidden="true" />
        )}
        {label}
      </Button>
      {error ? (
        <p role="alert" className="mt-2 animate-fade-in text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
