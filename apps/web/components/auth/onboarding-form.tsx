'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { readApiError } from '@/lib/read-api-error';
import { Button } from '@/components/ui/button';
import { apiBaseUrl } from '@/lib/api-config';

interface LegalEntity {
  tin: string;
  name: string;
  isDirector: boolean;
}

interface FormState {
  name: string;
  slug: string;
  legalName: string;
  stir: string;
  oked: string;
  mfo: string;
  bankAccount: string;
  bankName: string;
  legalAddress: string;
  phone: string;
  directorName: string;
}

const EMPTY: FormState = {
  name: '',
  slug: '',
  legalName: '',
  stir: '',
  oked: '',
  mfo: '',
  bankAccount: '',
  bankName: '',
  legalAddress: '',
  phone: '',
  directorName: '',
};

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm ' +
  'placeholder:text-muted-foreground focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

const labelClass = 'mb-1 block text-sm font-medium';

/** Matches the API's slug format: lowercase alphanumeric segments, hyphen-joined. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Company setup — the step that makes the signed-in caller an owner.
 *
 * Reached from two places: right after `/register` (a bare account, nothing
 * prefilled) and after a first-time OneID login (this account already proved
 * who its owner is to a government identity provider, so the company's own
 * registry details are prefilled from that — the user confirms rather than
 * retypes, but nothing is created without them pressing the button).
 */
export function OnboardingForm() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [slugEdited, setSlugEdited] = useState(false);
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrated = useHydrated();

  useEffect(() => {
    let cancelled = false;

    fetch(`${apiBaseUrl}/auth/oneid/legal-entities`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : { legalEntities: [] }))
      .then((body: { legalEntities?: LegalEntity[] }) => {
        if (cancelled || !body.legalEntities?.length) return;
        setEntities(body.legalEntities);
        applyEntity(
          body.legalEntities.find((entity) => entity.isDirector) ??
            body.legalEntities[0],
        );
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyEntity(entity: LegalEntity) {
    setForm((previous) => ({
      ...previous,
      name: entity.name,
      slug: slugEdited ? previous.slug : slugify(entity.name),
      legalName: entity.name,
      stir: entity.tin,
    }));
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((previous) => {
      const next = { ...previous, [key]: value };
      if (key === 'name' && !slugEdited) {
        next.slug = slugify(value);
      }
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    // The slug is derived here as well as while typing. The as-you-type
    // version only fires when `name`'s own onChange runs and the slug has not
    // been touched — anything that leaves the field blank (clearing it by
    // hand, an autofill that marks it edited, a programmatic fill that skips
    // the name handler) otherwise submits an empty slug, which the API
    // rejects with "must be longer than or equal to 2 characters" for a form
    // the user never saw a slug problem in.
    const name = form.name.trim();
    const slug = form.slug.trim() || slugify(name);

    // Optional fields are sent only when filled — an empty string would fail
    // the API's own format validators (e.g. "STIR must be exactly 9 digits"),
    // where omitting the field entirely is simply "not provided yet".
    const body: Record<string, string> = { name, slug };
    for (const [key, value] of Object.entries(form)) {
      if (key === 'name' || key === 'slug') continue;
      if (value.trim()) body[key] = value.trim();
    }

    try {
      const response = await fetch(`${apiBaseUrl}/auth/company`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        setError(await readApiError(response, 'Could not create your company.'));
        setSubmitting(false);
        return;
      }

      window.location.href = '/dashboard';
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {/*
        Every control is inert until React has hydrated.

        These are controlled inputs whose initial value is empty. Anything
        typed before hydration lives only in the DOM, and the first React
        render then overwrites it from state — the text vanishes as the page
        "finishes loading", with no error and nothing to retry. Disabling the
        set until then is what makes that impossible rather than unlikely.

        Unstyled: `border-0 p-0 m-0` because a fieldset carries a default
        border and padding that would otherwise draw a box around the form.
      */}
      <fieldset disabled={!hydrated} className="m-0 space-y-6 border-0 p-0">
        {entities.length > 0 ? (
          <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
            <p className="font-medium">Prefilled from OneID</p>
            <p className="mt-0.5 text-muted-foreground">
              Review the details below before confirming — nothing is created until you
              submit.
            </p>
            {entities.length > 1 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {entities.map((entity) => (
                  <button
                    key={entity.tin}
                    type="button"
                    onClick={() => applyEntity(entity)}
                    className="rounded-full border border-input bg-background px-3 py-1 text-xs hover:bg-accent"
                  >
                    {entity.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="name" className={labelClass}>
              Company name
            </label>
            <input
              id="name"
              required
              maxLength={200}
              value={form.name}
              onChange={(event) => setField('name', event.target.value)}
              className={inputClass}
              placeholder="Acme Legal"
            />
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="slug" className={labelClass}>
              Workspace URL
            </label>
            <input
              id="slug"
              required
              maxLength={80}
              value={form.slug}
              onChange={(event) => {
                setSlugEdited(true);
                setField('slug', slugify(event.target.value));
              }}
              className={inputClass}
              placeholder="acme-legal"
            />
          </div>
        </div>

        <fieldset className="space-y-4 border-t border-border pt-4">
          <legend className="mb-1 text-sm font-medium text-muted-foreground">
            Registry details (optional — can be added later)
          </legend>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="legalName" className={labelClass}>
                Legal name
              </label>
              <input
                id="legalName"
                maxLength={300}
                value={form.legalName}
                onChange={(event) => setField('legalName', event.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="stir" className={labelClass}>
                STIR
              </label>
              <input
                id="stir"
                inputMode="numeric"
                value={form.stir}
                onChange={(event) => setField('stir', event.target.value)}
                className={inputClass}
                placeholder="9 digits"
              />
            </div>

            <div>
              <label htmlFor="oked" className={labelClass}>
                OKED
              </label>
              <input
                id="oked"
                inputMode="numeric"
                value={form.oked}
                onChange={(event) => setField('oked', event.target.value)}
                className={inputClass}
                placeholder="5 digits"
              />
            </div>

            <div>
              <label htmlFor="mfo" className={labelClass}>
                MFO
              </label>
              <input
                id="mfo"
                inputMode="numeric"
                value={form.mfo}
                onChange={(event) => setField('mfo', event.target.value)}
                className={inputClass}
                placeholder="5 digits"
              />
            </div>

            <div>
              <label htmlFor="bankAccount" className={labelClass}>
                Bank account
              </label>
              <input
                id="bankAccount"
                inputMode="numeric"
                value={form.bankAccount}
                onChange={(event) => setField('bankAccount', event.target.value)}
                className={inputClass}
                placeholder="20 digits"
              />
            </div>

            <div>
              <label htmlFor="bankName" className={labelClass}>
                Bank name
              </label>
              <input
                id="bankName"
                maxLength={200}
                value={form.bankName}
                onChange={(event) => setField('bankName', event.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="phone" className={labelClass}>
                Phone
              </label>
              <input
                id="phone"
                type="tel"
                value={form.phone}
                onChange={(event) => setField('phone', event.target.value)}
                className={inputClass}
                placeholder="+998901234567"
              />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="legalAddress" className={labelClass}>
                Legal address
              </label>
              <input
                id="legalAddress"
                maxLength={500}
                value={form.legalAddress}
                onChange={(event) => setField('legalAddress', event.target.value)}
                className={inputClass}
              />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="directorName" className={labelClass}>
                Director
              </label>
              <input
                id="directorName"
                maxLength={200}
                value={form.directorName}
                onChange={(event) => setField('directorName', event.target.value)}
                className={inputClass}
              />
            </div>
          </div>
        </fieldset>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Creating workspace…' : 'Create workspace'}
        </Button>
      </fieldset>
    </form>
  );
}
