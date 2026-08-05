'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { apiBaseUrl } from '@/lib/api-config';

/**
 * Publishes a template's draft version.
 *
 * Behind a confirmation because publishing is what makes a version generatable
 * *and* immutable — from that point a change means a new version, and every
 * document already generated stays pinned to the one that produced it.
 *
 * The API validates on publish, not on save: it refuses a body that references
 * a placeholder the schema does not declare. That rejection is surfaced here in
 * full, since it names the offending keys and is the whole reason a publish
 * fails in practice.
 */
/**
 * The draft version id is resolved on demand rather than passed in.
 *
 * `Template.currentVersionId` only points at the *published* version, so it is
 * null for exactly the templates this button exists for. The draft lives in
 * `/templates/:id/versions`, and fetching it when the dialog opens keeps it out
 * of the list payload for every row that will never be published.
 */
export function PublishButton({
  templateId,
  templateName,
}: {
  templateId: string;
  templateName: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undeclared, setUndeclared] = useState<string[]>([]);

  async function resolveDraftVersionId(): Promise<string | null> {
    const response = await fetch(`${apiBaseUrl}/templates/${templateId}/versions`, {
      credentials: 'include',
    });
    if (!response.ok) return null;

    const versions = (await response.json()) as { id: string; status: string }[];
    // Newest draft first — the list is returned in descending version order.
    return versions.find((version) => version.status === 'DRAFT')?.id ?? null;
  }

  async function publish() {
    setSubmitting(true);
    setError(null);
    setUndeclared([]);

    try {
      const versionId = await resolveDraftVersionId();
      if (!versionId) {
        setError('This template has no draft version to publish.');
        setSubmitting(false);
        return;
      }

      const response = await fetch(
        `${apiBaseUrl}/templates/${templateId}/versions/${versionId}/publish`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
        },
      );

      if (!response.ok) {
        const parsed = await response.json().catch(() => null);
        const raw = parsed?.message;
        const inner = raw && typeof raw === 'object' ? raw : parsed;
        setError(
          typeof raw === 'string'
            ? raw
            : (inner?.message ?? 'Could not publish this version.'),
        );
        if (Array.isArray(inner?.undeclared)) setUndeclared(inner.undeclared);
        setSubmitting(false);
        return;
      }

      toast(`"${templateName}" published.`, 'success');
      setOpen(false);
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Publish
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!submitting) {
            setOpen(next);
            setError(null);
            setUndeclared([]);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish {templateName}?</DialogTitle>
            <DialogDescription>
              This version becomes generatable and can no longer be changed.
              Later edits create a new version; documents already generated stay
              pinned to the version that produced them.
            </DialogDescription>
          </DialogHeader>

          <Field
            label="Change note"
            htmlFor="publish-note"
            hint="Optional. Recorded on the version history."
          >
            <Input
              value={changeNote}
              onChange={(event) => setChangeNote(event.target.value)}
              maxLength={500}
            />
          </Field>

          {error ? (
            <Alert variant="destructive" className="mt-4" title="Publish refused">
              {error}
              {undeclared.length > 0 ? (
                <p className="mt-1">
                  Undeclared placeholders:{' '}
                  <code>{undeclared.join(', ')}</code>
                </p>
              ) : null}
            </Alert>
          ) : null}

          <DialogFooter>
            <Button variant="outline" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={submitting} onClick={() => void publish()}>
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  Publishing…
                </>
              ) : (
                'Publish'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
