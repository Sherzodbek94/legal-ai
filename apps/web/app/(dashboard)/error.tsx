'use client';

import { useEffect } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

/**
 * Catches an unhandled throw inside a dashboard route.
 *
 * Renders in place of the page but *inside* the shell, so the sidebar and
 * header survive and the user can navigate away — a top-level crash screen
 * would strand them with only the browser back button.
 *
 * `reset()` re-runs the failed render, which is the right offer here: most
 * failures at this layer are a transient API error rather than a bad route.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side digest only; the real stack stays on the server in
    // production. Logged so it is at least visible in a browser console.
    console.error('Dashboard route error:', error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>

      <Alert variant="destructive" className="mt-4" title="This page could not be displayed">
        {error.message || 'An unexpected error occurred.'}
        {error.digest ? (
          <span className="mt-1 block text-xs">Reference: {error.digest}</span>
        ) : null}
      </Alert>

      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={reset}>
          <RotateCcw aria-hidden="true" />
          Try again
        </Button>
      </div>
    </div>
  );
}
