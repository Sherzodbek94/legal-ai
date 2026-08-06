'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * Shown while an AI draft is still running, and refreshes the page when it is
 * not.
 *
 * The document below this notice is already complete — it holds the
 * interpolated template text from the moment it was created, and the draft
 * replaces that body if the model answers. So this is not a loading screen
 * standing between the reader and their document; it is a note that the text
 * they are looking at may be about to improve, and they can read, export or
 * ignore it in the meantime.
 *
 * Polling rather than the websocket, deliberately. The gateway push exists and
 * arrives first when a socket happens to be open, but a drafter who reloads,
 * opens the document in a second tab, or comes back from a locked laptop has no
 * socket to receive it — and this is the one screen where "nothing ever
 * happened" is the failure the whole change was meant to remove.
 */
export function GeneratingNotice({
  /** Milliseconds between checks. */
  intervalMs = 4000,
  /** Stop after this long and say so, rather than spinning forever. */
  giveUpAfterMs = 5 * 60_000,
}: {
  intervalMs?: number;
  giveUpAfterMs?: number;
}) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    // `gaveUp` is a dependency so React's own cleanup stops the interval when
    // it flips. Clearing inside the callback that is being cleared is the kind
    // of thing that works until it doesn't.
    if (gaveUp) return;

    const startedAt = Date.now();

    const timer = window.setInterval(() => {
      if (Date.now() - startedAt >= giveUpAfterMs) {
        // The worker bounds itself at three attempts of two minutes, so past
        // this point nothing is coming and the poll is just noise on the API.
        setGaveUp(true);
        return;
      }
      // Re-runs the server component; when the status has moved on, this
      // notice is no longer rendered at all.
      router.refresh();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [router, intervalMs, giveUpAfterMs, gaveUp]);

  if (gaveUp) {
    return (
      <div
        role="status"
        className="animate-fade-in rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"
      >
        <p className="font-medium">The AI draft did not arrive.</p>
        <p className="mt-0.5 text-muted-foreground">
          The document below is the template text with your values filled in —
          complete and usable. Reload if you want to check again.
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-fade-in flex items-start gap-3 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"
    >
      <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      <div>
        <p className="font-medium">Drafting with AI…</p>
        <p className="mt-0.5 text-muted-foreground">
          The document below is already filled in from the template — read or
          export it now if you prefer. This page updates itself when the draft
          lands.
        </p>
      </div>
    </div>
  );
}
