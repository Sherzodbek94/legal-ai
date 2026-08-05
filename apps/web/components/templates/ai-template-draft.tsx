'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Textarea, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { apiBaseUrl } from '@/lib/api-config';
import { useHydrated } from '@/lib/use-hydrated';

interface DraftVariable {
  key: string;
  label: string;
  type: string;
  required: boolean;
}

interface DraftSection {
  heading: string;
  body: string;
  order: number;
}

interface DraftResponse {
  draft: {
    title: string;
    purpose: string;
    sections: DraftSection[];
    variables: DraftVariable[];
    reviewNotes: string[];
  };
  issues: {
    undeclared: string[];
    unused: string[];
    invalidKeys: string[];
    thinSections: string[];
  };
}

export interface AppliedDraft {
  name: string;
  description: string;
  body: string;
  variables: DraftVariable[];
  reviewNotes: string[];
}

/**
 * Drafting a template with AI.
 *
 * The templates this product shipped with were skeletons — a heading, a
 * contract number, a payment line — so a contract generated from one had no
 * subject clause, no obligations, no liability, and no dispute forum. This is
 * the entry point to the model that writes the rest.
 *
 * It fills the builder rather than saving anything. Everything the API refuses
 * to publish — an undeclared placeholder, a body with nothing to fill in — is
 * refused for good reasons, and a path that wrote straight to the catalogue
 * would bypass the review the builder exists to provide.
 */
export function AiTemplateDraft({ onApply }: { onApply: (draft: AppliedDraft) => void }) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [documentType, setDocumentType] = useState('');
  const [language, setLanguage] = useState('uz-Latn');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DraftResponse | null>(null);

  async function draft() {
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch(`${apiBaseUrl}/ai-engine/draft-template`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          documentType: documentType.trim(),
          language,
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string | { message?: string | string[] };
        } | null;

        const inner = body?.message;
        const message =
          typeof inner === 'string'
            ? inner
            : typeof inner?.message === 'string'
              ? inner.message
              : Array.isArray(inner?.message)
                ? inner.message.join(' ')
                : null;

        setError(
          response.status === 403
            ? 'Your plan does not include AI generation.'
            : (message ?? 'Could not draft a template. Try again.'),
        );
        return;
      }

      setResult((await response.json()) as DraftResponse);
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  function apply(response: DraftResponse) {
    onApply({
      name: response.draft.title,
      description: response.draft.purpose,
      // Rendered back to the builder's plain-text form rather than handed over
      // as editor JSON: the builder derives its variable list from the text, so
      // giving it anything else would leave the two out of step.
      body: toBuilderText(response.draft.sections, response.draft.title),
      variables: response.draft.variables,
      reviewNotes: [
        ...response.draft.reviewNotes,
        ...response.issues.thinSections.map(
          (heading) => `"${heading}" is very short — expand it before publishing.`,
        ),
        ...response.issues.undeclared.map(
          (key) => `{{${key}}} appears in the text but was not declared.`,
        ),
      ],
    });
    setOpen(false);
    setResult(null);
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={!hydrated}
        >
          <Sparkles aria-hidden="true" />
          Draft with AI
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-expand-in space-y-4 rounded-md border border-border bg-muted/30 p-4">
      <div>
        <h3 className="text-sm font-medium">Draft this template with AI</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Produces a full clause structure — subject, payment, obligations,
          liability, force majeure, disputes. It fills the form below; nothing is
          saved until you publish.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <Field label="Document type" htmlFor="ai-doc-type" required>
          <Input
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value)}
            placeholder="tovar yetkazib berish shartnomasi"
            maxLength={200}
          />
        </Field>
        <Field label="Language" htmlFor="ai-language">
          <Select
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            <option value="uz-Latn">O&apos;zbekcha (lotin)</option>
            <option value="uz-Cyrl">Ўзбекча (кирилл)</option>
            <option value="ru">Русский</option>
          </Select>
        </Field>
      </div>

      <Field
        label="Requirements"
        htmlFor="ai-requirements"
        hint="Optional. Clauses this template must cover, payment terms, anything specific to your practice."
      >
        <Textarea
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={2000}
        />
      </Field>

      {error ? (
        <p role="alert" className="animate-fade-in text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="animate-expand-in space-y-3 rounded-md border border-border bg-background p-3">
          <div>
            <p className="text-sm font-medium">{result.draft.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {result.draft.sections.length} clauses ·{' '}
              {result.draft.variables.length} variables
            </p>
          </div>

          <ol className="space-y-0.5 text-xs text-muted-foreground">
            {result.draft.sections.map((section) => (
              <li key={section.order}>{section.heading}</li>
            ))}
          </ol>

          {result.issues.undeclared.length > 0 ? (
            <Alert variant="warning" title="Placeholders with no variable">
              {/* The one that reaches a signed page: an undeclared placeholder
                  prints literally in a generated contract. */}
              {result.issues.undeclared.join(', ')} — declare these in the
              builder, or the contract will print them as written.
            </Alert>
          ) : null}

          {result.issues.thinSections.length > 0 ? (
            <p className="flex gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                Short clauses to expand: {result.issues.thinSections.join(', ')}
              </span>
            </p>
          ) : null}

          <Button type="button" onClick={() => apply(result)}>
            Use this draft
          </Button>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={() => void draft()}
          disabled={busy || documentType.trim().length === 0}
        >
          {busy ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Drafting…
            </>
          ) : (
            <>
              <Sparkles aria-hidden="true" />
              {result ? 'Draft again' : 'Draft'}
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setResult(null);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The drafted sections as the builder's plain text.
 *
 * `#` for the title and `##` for each clause, matching what `textToTipTap`
 * parses. Clauses are renumbered from `order` here as well as on the API side,
 * because the model's own numbering is what the user would otherwise see in the
 * textarea before saving.
 */
function toBuilderText(sections: DraftSection[], title: string): string {
  const ordered = [...sections].sort((a, b) => a.order - b.order);

  return [
    `# ${title}`,
    ...ordered.flatMap((section, index) => [
      `## ${index + 1}. ${section.heading.replace(/^\s*\d+[.)]\s*/, '').trim()}`,
      section.body.trim(),
    ]),
  ].join('\n\n');
}
