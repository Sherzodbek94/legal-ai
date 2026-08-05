'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { apiBaseUrl } from '@/lib/api-config';
import { useHydrated } from '@/lib/use-hydrated';

interface RegistryEntity {
  legalName: string;
  shortName?: string;
  stir: string;
  oked?: string;
  legalAddress?: string;
  directorName?: string;
  directorPosition?: string;
  phone?: string;
  email?: string;
  status: 'ACTIVE' | 'LIQUIDATED' | 'SUSPENDED' | 'UNKNOWN';
  registeredAt?: string;
}

type LookupResponse =
  | { found: false; stir: string }
  | {
      found: true;
      source: string;
      retrievedAt: string;
      entity: RegistryEntity;
      variables: Record<string, string>;
    };

/**
 * How a registry status reads to a drafter about to name this party in a
 * contract. `UNKNOWN` is shown rather than hidden: "we could not establish
 * whether this company is trading" is information, and suppressing it would
 * leave the row looking as clean as a confirmed-active one.
 */
const STATUS_COPY: Record<RegistryEntity['status'], { label: string; warn: boolean }> = {
  ACTIVE: { label: 'Active', warn: false },
  LIQUIDATED: { label: 'Liquidated', warn: true },
  SUSPENDED: { label: 'Suspended', warn: true },
  UNKNOWN: { label: 'Status not reported', warn: true },
};

/**
 * Looks the other party up in the state business registry and offers to fill
 * the contract's `counterparty_*` fields.
 *
 * Nothing is applied automatically. The result is shown, and a separate
 * confirmation writes it into the form — the same rule OneID's legal-entity
 * prefill follows, because a STIR that reaches a signed contract wrong is a
 * liability rather than a typo.
 */
export function CounterpartyLookup({
  onApply,
  missingFromRegistry,
}: {
  onApply: (variables: Record<string, string>) => void;
  /** Declared `counterparty_*` fields a registry cannot supply, e.g. bank details. */
  missingFromRegistry: string[];
}) {
  const hydrated = useHydrated();
  const [stir, setStir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResponse | null>(null);
  const [applied, setApplied] = useState(false);

  const complete = stir.replace(/\D/g, '').length === 9;

  async function search() {
    setBusy(true);
    setError(null);
    setResult(null);
    setApplied(false);

    try {
      const response = await fetch(
        `${apiBaseUrl}/counterparties/lookup?stir=${encodeURIComponent(stir.replace(/\D/g, ''))}`,
        { credentials: 'include' },
      );

      if (response.status === 503) {
        // Distinct from "not registered" on purpose: telling someone their
        // correct STIR does not exist sends them off editing a right answer.
        setError('The registry could not be reached. Try again shortly.');
        return;
      }

      if (!response.ok) {
        setError('That does not look like a valid STIR.');
        return;
      }

      setResult((await response.json()) as LookupResponse);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div>
        <h3 className="text-sm font-medium">Look up the other party</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Fills the counterparty fields from the state business registry. You
          confirm before anything is applied.
        </p>
      </div>

      {/* A <div>, not a nested <form>: HTML forbids form nesting, and React
          would render it anyway into markup browsers silently flatten. */}
      <div className="flex items-end gap-2">
        <Field label="Counterparty STIR" htmlFor="counterparty-stir" className="flex-1">
          <Input
            inputMode="numeric"
            value={stir}
            onChange={(event) =>
              setStir(event.target.value.replace(/\D/g, '').slice(0, 9))
            }
            // This field lives inside the generate form. Enter in a text input
            // submits the form it belongs to, which would generate a document
            // from a half-filled draft — so Enter runs the lookup instead.
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (complete && !busy) void search();
            }}
            placeholder="9 digits"
          />
        </Field>
        <Button
          type="button"
          variant="outline"
          onClick={() => void search()}
          disabled={busy || !complete || !hydrated}
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Search aria-hidden="true" />
          )}
          Look up
        </Button>
      </div>

      {error ? (
        <p role="alert" className="animate-fade-in text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {result && !result.found ? (
        <p role="alert" className="animate-fade-in text-xs text-muted-foreground">
          No company is registered under STIR {result.stir}.
        </p>
      ) : null}

      {result?.found ? (
        <div className="animate-expand-in space-y-3">
          <dl className="space-y-1 rounded-md bg-muted/50 p-3 text-sm">
            <Row label="Legal name" value={result.entity.legalName} />
            <Row label="STIR" value={result.entity.stir} />
            {result.entity.legalAddress ? (
              <Row label="Address" value={result.entity.legalAddress} />
            ) : null}
            {result.entity.directorName ? (
              <Row label="Director" value={result.entity.directorName} />
            ) : null}
            <Row label="Registry status" value={STATUS_COPY[result.entity.status].label} />
          </dl>

          {STATUS_COPY[result.entity.status].warn ? (
            <Alert variant="warning" title="Check before signing">
              The registry reports this company as{' '}
              {STATUS_COPY[result.entity.status].label.toLowerCase()}.
            </Alert>
          ) : null}

          {missingFromRegistry.length > 0 ? (
            <p className="flex gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                Bank details are not published in the register — {' '}
                {missingFromRegistry.join(', ')} still have to come from the
                counterparty.
              </span>
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={() => {
                onApply((result as Extract<LookupResponse, { found: true }>).variables);
                setApplied(true);
              }}
              disabled={applied}
            >
              {applied ? 'Applied' : 'Use these details'}
            </Button>
            <p className="text-xs text-muted-foreground">
              {result.source} · retrieved{' '}
              {new Date(result.retrievedAt).toLocaleString()}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{value}</dd>
    </div>
  );
}
