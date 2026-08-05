'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { apiBaseUrl } from '@/lib/api-config';
import { collectPlaceholders, textToTipTap } from '@/lib/template-content';
import { AiTemplateDraft, type AppliedDraft } from './ai-template-draft';

export interface CategoryOption {
  id: string;
  name: string;
  path?: string;
}

interface VariableDraft {
  key: string;
  label: string;
  type: string;
  required: boolean;
}

const VARIABLE_TYPES = ['string', 'text', 'date', 'money', 'integer', 'boolean'] as const;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

const SAMPLE = `# ШАРТНОМА

№ {{contract_number}} от {{signed_at}}

Настоящий договор заключён между {{company_legal_name}} (далее — Поставщик) и {{counterparty_name}} (далее — Покупатель).

Общая сумма договора составляет {{amount}}.`;

/**
 * Template authoring.
 *
 * The whole CRUD surface behind this — create, versions, publish, rollback —
 * has been implemented and tested since the beginning and had no caller: the
 * catalogue was read-only and templates could only arrive through the seed
 * script.
 *
 * Variables are derived from the body rather than declared separately, because
 * the API refuses to publish a version whose body references a placeholder the
 * schema does not declare. Deriving them means that rejection cannot happen by
 * accident — the two are the same list by construction.
 */
export function TemplateBuilder({ categories }: { categories: CategoryOption[] }) {
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [body, setBody] = useState(SAMPLE);
  const [labels, setLabels] = useState<Record<string, VariableDraft>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ key: string; message: string }[]>([]);
  /** Notes the AI draft left behind for the author to resolve before publishing. */
  const [draftNotes, setDraftNotes] = useState<string[]>([]);

  const placeholders = useMemo(() => collectPlaceholders(body), [body]);

  const variables: VariableDraft[] = placeholders.map(
    (key) =>
      labels[key] ?? {
        key,
        label: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        type: 'string',
        required: true,
      },
  );

  function updateVariable(key: string, patch: Partial<VariableDraft>) {
    setLabels((current) => ({
      ...current,
      [key]: { ...(current[key] ?? variables.find((v) => v.key === key)!), ...patch },
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIssues([]);

    if (placeholders.length === 0) {
      setError(
        'The body has no {{placeholders}}. A template with nothing to fill in produces the same document every time.',
      );
      return;
    }

    setSubmitting(true);

    const payload = {
      name: name.trim(),
      slug: slug.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      categoryId,
      content: textToTipTap(body),
      variableSchema: {
        version: 1,
        variables: variables.map((variable) => ({
          key: variable.key,
          label: variable.label,
          type: variable.type,
          required: variable.required,
        })),
      },
    };

    try {
      const response = await fetch(`${apiBaseUrl}/templates`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const parsed = await response.json().catch(() => null);
        const raw = parsed?.message;
        const inner = raw && typeof raw === 'object' ? raw : parsed;
        setError(
          typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? raw.join(', ')
              : (inner?.message ?? 'Could not create the template.'),
        );
        if (Array.isArray(inner?.issues)) setIssues(inner.issues);
        setSubmitting(false);
        return;
      }

      const created = (await response.json()) as { id: string };
      toast(`"${name.trim()}" created as a draft.`, 'success');
      // Full navigation so the list re-renders from the server.
      window.location.href = `/templates?created=${created.id}`;
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  /**
   * Fills the form from an AI draft.
   *
   * `labels` is seeded from the drafted variables so their types and labels
   * survive — the derived list falls back to "every placeholder is a required
   * string", which would throw away the model's judgement that an amount is
   * money and a deadline is an integer.
   */
  function applyDraft(applied: AppliedDraft) {
    setName(applied.name);
    if (!slugEdited) setSlug(slugify(applied.name));
    setDescription(applied.description);
    setBody(applied.body);
    setDraftNotes(applied.reviewNotes);
    setLabels(
      Object.fromEntries(
        applied.variables.map((variable) => [
          variable.key,
          {
            key: variable.key,
            label: variable.label,
            type: variable.type,
            required: variable.required,
          },
        ]),
      ),
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <AiTemplateDraft onApply={applyDraft} />

      {draftNotes.length > 0 ? (
        <Alert variant="warning" title="Review before publishing">
          <ul className="list-disc space-y-1 pl-4">
            {draftNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Details</CardTitle>
            <CardDescription>
              Created as a draft. Nothing can be generated from it until you publish.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="tpl-name" className="sm:col-span-2" required>
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (!slugEdited) setSlug(slugify(event.target.value));
              }}
              placeholder="Товар етказиб бериш шартномаси"
              maxLength={200}
            />
          </Field>

          <Field label="Slug" htmlFor="tpl-slug" required>
            <Input
              value={slug}
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(slugify(event.target.value));
              }}
              placeholder="supply-agreement"
            />
          </Field>

          <Field label="Category" htmlFor="tpl-category" required>
            <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.path ?? category.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Description" htmlFor="tpl-description" className="sm:col-span-2">
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={1000}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Body</CardTitle>
            <CardDescription>
              Write <code>{'{{placeholder}}'}</code> where a value goes. Start a line
              with <code>#</code> for a heading; a blank line starts a paragraph.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Field label="Template text" htmlFor="tpl-body" required>
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={14}
              className="font-mono text-xs"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Variables</CardTitle>
            <CardDescription>
              Found in the body. Every placeholder must be declared — the API
              refuses to publish a body that references anything missing.
            </CardDescription>
          </div>
          <Badge variant={placeholders.length > 0 ? 'secondary' : 'outline'}>
            {placeholders.length} found
          </Badge>
        </CardHeader>

        {variables.length === 0 ? (
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No placeholders yet. Add <code>{'{{something}}'}</code> to the body above.
          </CardContent>
        ) : (
          <ul className="divide-y divide-border">
            {variables.map((variable) => (
              <li key={variable.key} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_1fr_auto]">
                <Field label="Label" htmlFor={`label-${variable.key}`}>
                  <Input
                    value={variable.label}
                    onChange={(event) =>
                      updateVariable(variable.key, { label: event.target.value })
                    }
                  />
                </Field>

                <Field label="Type" htmlFor={`type-${variable.key}`} hint={`{{${variable.key}}}`}>
                  <Select
                    value={variable.type}
                    onChange={(event) =>
                      updateVariable(variable.key, { type: event.target.value })
                    }
                  >
                    {VARIABLE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </Select>
                </Field>

                <label className="flex items-end gap-2 pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={variable.required}
                    onChange={(event) =>
                      updateVariable(variable.key, { required: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-input"
                  />
                  Required
                </label>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {error ? (
        <Alert variant="destructive" title="Could not create the template">
          {error}
          {issues.length > 0 ? (
            <ul className="mt-2 list-inside list-disc">
              {issues.map((issue) => (
                <li key={issue.key}>
                  <strong>{issue.key}</strong>: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={submitting || !name.trim() || !categoryId}>
          {submitting ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Creating…
            </>
          ) : (
            <>
              <Plus aria-hidden="true" />
              Create draft
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
