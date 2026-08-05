'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiBaseUrl } from '@/lib/api-config';

/**
 * Google's mark, inline.
 *
 * Drawn rather than fetched: the strict CSP on this app blocks remote images,
 * and Google's brand guidelines require the four-colour logo at its own
 * proportions — a monochrome substitute is not permitted on a sign-in button.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.65 3.58 9 3.58Z"
      />
    </svg>
  );
}

/**
 * Starts the Google sign-in redirect.
 *
 * The authorize URL is fetched rather than hard-coded because the `state` it
 * carries is minted server-side and held in Redis — a client-built URL could
 * not produce one, and without it the callback has no CSRF defence.
 *
 * Whether it renders at all is decided server-side from `/auth/providers` — see
 * `getAuthProviders`. The self-hiding below is the leftover case that check
 * cannot cover: credentials removed between the page render and the click.
 */
export function GoogleButton({ label = 'Continue with Google' }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  if (unavailable) return null;

  async function start() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/google/authorize`, {
        credentials: 'include',
      });

      if (response.status === 503) {
        setUnavailable(true);
        return;
      }
      if (!response.ok) throw new Error();

      const { url } = (await response.json()) as { url: string };
      window.location.href = url;
    } catch {
      setError('Could not start Google sign-in. Try again.');
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
          <GoogleMark />
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
