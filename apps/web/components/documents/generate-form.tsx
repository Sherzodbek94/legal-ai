'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { CounterpartyLookup } from './counterparty-lookup';
import type { VariableDefinition } from '@/lib/variable-schema';
import type { GenerateState } from '@/app/(dashboard)/templates/[id]/generate/actions';

interface GenerateFormProps {
  definitions: VariableDefinition[];
  /** Pre-filled from the company profile; the caller may override any of them. */
  companyDefaults: Record<string, string>;
  templateName: string;
  aiAvailable: boolean;
  /** Whether this deployment can query the business registry at all. */
  counterpartyLookupAvailable: boolean;
  action: (state: GenerateState, formData: FormData) => Promise<GenerateState>;
}

/** Counterparty fields a public registry does not publish. */
const NOT_IN_REGISTRY = [
  'counterparty_mfo',
  'counterparty_bank_account',
  'counterparty_bank_name',
];

const INITIAL: GenerateState = {};

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm ' +
  'ring-offset-background placeholder:text-muted-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export function GenerateForm({
  definitions,
  companyDefaults,
  templateName,
  aiAvailable,
  counterpartyLookupAvailable,
  action,
}: GenerateFormProps) {
  const [state, formAction] = useFormState(action, INITIAL);

  /**
   * Values the registry lookup filled in, layered over the company defaults.
   *
   * Held here rather than written into the inputs directly because the fields
   * are uncontrolled: `revision` changes their `key`, which remounts them so
   * the new `defaultValue` is picked up. Reaching into the DOM would work
   * until React re-rendered the field for any other reason and reverted it.
   */
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);

  const declared = new Set(definitions.map((definition) => definition.key));

  const valueFor = (definition: VariableDefinition) =>
    applied[definition.key] ?? companyDefaults[definition.key];

  /**
   * Two ways a field earns its place behind the disclosure.
   *
   * `advanced` is the template author's call — a statutory or house-standard
   * term, guaranteed by the API to be optional or carry a default, so leaving
   * the disclosure closed still submits.
   *
   * The second is this component's: a field already filled from the company
   * profile. Across the shipped templates that is six to eight fields each —
   * the drafter's own STIR, address, bank details and director — and nobody
   * needs to review their own registered particulars to paper a hire. It is
   * decided per render rather than in the schema precisely because it depends
   * on whether the value actually arrived: an incomplete profile leaves the
   * field blank, and a blank required field stays in front of the drafter
   * where they can see what is missing. Hiding it would produce a form that
   * cannot be submitted and does not say why.
   */
  const isPrefilled = (definition: VariableDefinition) =>
    Boolean(companyDefaults[definition.key]?.trim());

  const essential = definitions.filter(
    (definition) => !definition.advanced && !isPrefilled(definition),
  );
  const advanced = definitions.filter(
    (definition) => definition.advanced || isPrefilled(definition),
  );

  const advancedHasError = advanced.some(
    (definition) => state.fieldErrors?.[definition.key],
  );

  // Offered only when the template actually names a second party — most HR
  // orders and internal acts have none, and the panel would be noise there.
  const showLookup =
    counterpartyLookupAvailable &&
    definitions.some((definition) => definition.key.startsWith('counterparty_'));

  return (
    <form action={formAction} className="space-y-6">
      {state.message ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {state.message}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="title" className="text-sm font-medium">
          Title
        </label>
        <input
          id="title"
          name="title"
          className={inputClass}
          placeholder={templateName}
          maxLength={200}
        />
        <p className="text-xs text-muted-foreground">
          Defaults to the template name.
        </p>
      </div>

      {showLookup ? (
        <CounterpartyLookup
          missingFromRegistry={NOT_IN_REGISTRY.filter((key) => declared.has(key))}
          onApply={(variables) => {
            // Only keys this template declares. The API rejects a submission
            // carrying an undeclared variable, so passing the rest through
            // would turn a successful lookup into a failed generation.
            setApplied(
              Object.fromEntries(
                Object.entries(variables).filter(([key]) => declared.has(key)),
              ),
            );
            setRevision((n) => n + 1);
          }}
        />
      ) : null}

      {definitions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This template declares no variables — its text is used as published.
        </p>
      ) : (
        <>
          <fieldset className="space-y-5">
            <legend className="text-sm font-medium">Variables</legend>
            {essential.map((definition) => (
              <Field
                key={`${definition.key}:${revision}`}
                definition={definition}
                defaultValue={valueFor(definition)}
                error={state.fieldErrors?.[definition.key]}
              />
            ))}
          </fieldset>

          {advanced.length > 0 ? (
            <details
              className="rounded-md border border-border"
              // Opened when the server rejected one of the hidden fields.
              // Otherwise the error renders inside a closed disclosure and the
              // form looks like it failed for no reason.
              open={advancedHasError}
            >
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                Already filled in
                <span className="ml-2 font-normal text-muted-foreground">
                  {advanced.length} {advanced.length === 1 ? 'field' : 'fields'} — your
                  company details and standard terms
                </span>
              </summary>

              <fieldset className="space-y-5 border-t border-border px-4 py-4">
                {/* These are statutory or house-standard figures, identical on
                    almost every contract. They are editable — a term the law
                    sets a floor for can still be improved on — but they should
                    not stand between a drafter and a routine document. */}
                {advanced.map((definition) => (
                  <Field
                    key={`${definition.key}:${revision}`}
                    definition={definition}
                    defaultValue={valueFor(definition)}
                    error={state.fieldErrors?.[definition.key]}
                  />
                ))}
              </fieldset>
            </details>
          ) : null}
        </>
      )}

      <div className="space-y-3 rounded-md border border-border p-4">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="useAi"
            className="mt-0.5 h-4 w-4"
            disabled={!aiAvailable}
          />
          <span>
            <span className="font-medium">Draft with AI</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {aiAvailable
                ? 'Consumes an AI generation from your plan in addition to the document. Leave off to fill the published template text, which costs nothing and is deterministic.'
                : 'Unavailable — your plan does not include AI generation.'}
            </span>
          </span>
        </label>

        <div className="space-y-1.5">
          <label htmlFor="instructions" className="text-sm font-medium">
            Drafting instructions
          </label>
          <textarea
            id="instructions"
            name="instructions"
            rows={3}
            maxLength={4000}
            className={inputClass}
            placeholder="Optional. Ignored unless drafting with AI."
          />
        </div>
      </div>

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Generating…' : 'Generate document'}
    </Button>
  );
}

function Field({
  definition,
  defaultValue,
  error,
}: {
  definition: VariableDefinition;
  defaultValue?: string;
  error?: string;
}) {
  const id = `var:${definition.key}`;
  const describedBy = [
    definition.description ? `${id}-help` : null,
    error ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(' ');

  // The schema default only applies server-side when a field is left empty, so
  // it is shown as a placeholder rather than pre-filled — pre-filling would make
  // "unset" indistinguishable from "deliberately set to the default".
  const placeholder =
    definition.defaultValue !== undefined
      ? String(definition.defaultValue)
      : undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline gap-2 text-sm font-medium">
        {definition.label}
        {definition.required ? (
          <span className="text-xs font-normal text-destructive">Required</span>
        ) : (
          <span className="text-xs font-normal text-muted-foreground">
            Optional
          </span>
        )}
      </label>

      <Control
        id={id}
        definition={definition}
        defaultValue={defaultValue}
        placeholder={placeholder}
        invalid={Boolean(error)}
        describedBy={describedBy || undefined}
      />

      {definition.description ? (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {definition.description}
        </p>
      ) : null}

      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Control({
  id,
  definition,
  defaultValue,
  placeholder,
  invalid,
  describedBy,
}: {
  id: string;
  definition: VariableDefinition;
  defaultValue?: string;
  placeholder?: string;
  invalid: boolean;
  describedBy?: string;
}) {
  const shared = {
    id,
    name: id,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    className: `${inputClass}${invalid ? ' border-destructive' : ''}`,
  };

  switch (definition.type) {
    case 'enum':
      return (
        <select {...shared} defaultValue={defaultValue ?? ''}>
          <option value="">Select…</option>
          {(definition.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );

    case 'text':
      return (
        <textarea
          {...shared}
          rows={4}
          defaultValue={defaultValue}
          placeholder={placeholder}
          maxLength={definition.maxLength}
        />
      );

    case 'boolean':
      return (
        <input
          {...shared}
          type="checkbox"
          className="h-4 w-4"
          defaultChecked={defaultValue === 'true'}
        />
      );

    case 'date':
      return (
        <input {...shared} type="date" defaultValue={defaultValue} />
      );

    case 'number':
    case 'integer':
    case 'money':
      return (
        <input
          {...shared}
          type="number"
          // `any` for money and decimals; whole numbers get a 1 step so the
          // browser's own spinner cannot produce a value the API will reject.
          step={definition.type === 'integer' ? 1 : 'any'}
          min={definition.min}
          max={definition.max}
          defaultValue={defaultValue}
          placeholder={
            definition.type === 'money'
              ? `Amount in ${definition.currency ?? 'UZS'}`
              : placeholder
          }
        />
      );

    default:
      return (
        <input
          {...shared}
          type="text"
          defaultValue={defaultValue}
          placeholder={placeholder}
          minLength={definition.minLength}
          maxLength={definition.maxLength}
        />
      );
  }
}
