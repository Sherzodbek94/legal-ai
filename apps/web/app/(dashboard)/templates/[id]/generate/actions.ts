'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiPost, type ApiIssue } from '@/lib/api';
import type { VariableDefinition } from '@/lib/variable-schema';

export interface GenerateState {
  message?: string;
  /** Field-level errors, keyed by variable. */
  fieldErrors?: Record<string, string>;
}

interface CreatedDocument {
  id: string;
}

/**
 * Creates a document from a template.
 *
 * A Server Action rather than a client fetch: the session lives in an HTTPOnly
 * cookie this process can forward, and posting from the browser to the API's
 * origin would need CORS credentials plus a looser SameSite policy.
 *
 * The variable definitions are passed in bound rather than read from the form,
 * because the form is user-controlled and the types drive coercion — trusting
 * the client's idea of which field is a number is how a string reaches a
 * numeric column.
 */
export async function generateDocument(
  templateId: string,
  definitions: VariableDefinition[],
  _previous: GenerateState,
  formData: FormData,
): Promise<GenerateState> {
  const variables: Record<string, unknown> = {};

  for (const definition of definitions) {
    const raw = formData.get(`var:${definition.key}`);

    if (definition.type === 'boolean') {
      // An unchecked checkbox submits nothing at all, which is a meaningful
      // `false` rather than an omission.
      variables[definition.key] = raw === 'on' || raw === 'true';
      continue;
    }

    if (typeof raw !== 'string' || raw.trim() === '') {
      // Left out entirely, so the API applies the schema's default or reports
      // it as missing. Sending "" would look like a deliberate empty value.
      continue;
    }

    variables[definition.key] = raw.trim();
  }

  const useAi = formData.get('useAi') === 'on';
  const title = String(formData.get('title') ?? '').trim();
  const instructions = String(formData.get('instructions') ?? '').trim();

  const result = await apiPost<CreatedDocument>('/documents', {
    templateId,
    variables,
    useAi,
    ...(title ? { title } : {}),
    ...(useAi && instructions ? { instructions } : {}),
  });

  if (!result.ok) {
    return {
      message: result.message,
      fieldErrors: toFieldErrors(result.issues),
    };
  }

  revalidatePath('/documents');
  // Outside the try/catch shape above on purpose: redirect() signals by
  // throwing, and catching it here would swallow the navigation.
  redirect(`/documents/${result.data.id}`);
}

function toFieldErrors(
  issues: ApiIssue[] | undefined,
): Record<string, string> | undefined {
  if (!issues?.length) return undefined;

  const errors: Record<string, string> = {};
  for (const issue of issues) {
    // First error per field wins; the validator emits at most one per key
    // anyway, and showing two under one input reads as a bug.
    errors[issue.key] ??= issue.message;
  }
  return errors;
}
