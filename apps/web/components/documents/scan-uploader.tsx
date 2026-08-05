'use client';

import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { useToast } from '@/components/ui/toast';
import { apiBaseUrl } from '@/lib/api-config';
import { cn } from '@/lib/utils';

/** Mirrors MAX_UPLOAD_BYTES in ocr-search.controller.ts. */
const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

/**
 * Uploads a scan for text extraction.
 *
 * A plain `fetch` with `FormData` rather than the shared `apiPost` helper:
 * that one sets `content-type: application/json`, and a multipart body needs
 * the browser to set the header itself so it can append the boundary.
 *
 * Client-side size and type checks are a courtesy, not the control — the API
 * enforces both, and reads the magic bytes rather than trusting the declared
 * type. Doing it here just avoids spending a 25MB upload to be told no.
 */
export function ScanUploader() {
  const router = useRouter();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function upload(file: File) {
    setError(null);

    if (file.size > MAX_BYTES) {
      setError(`"${file.name}" is larger than the 25MB limit.`);
      return;
    }
    if (!ACCEPTED.includes(file.type)) {
      setError('Upload a PDF, PNG, JPEG, or WebP file.');
      return;
    }

    setUploading(true);
    const body = new FormData();
    body.append('file', file);

    try {
      const response = await fetch(`${apiBaseUrl}/search/documents`, {
        method: 'POST',
        credentials: 'include',
        body,
      });

      if (!response.ok) {
        const parsed = await response.json().catch(() => null);
        setError(
          response.status === 402 || response.status === 403
            ? (parsed?.message ?? 'Your plan does not allow another upload this period.')
            : (parsed?.message ?? 'Upload failed. Please try again.'),
        );
        setUploading(false);
        return;
      }

      toast(`"${file.name}" uploaded — extraction starts shortly.`, 'success');
      if (inputRef.current) inputRef.current.value = '';
      // Extraction is asynchronous (a 30s poller), so the row lands as
      // PENDING and the status column updates on a later refresh.
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setUploading(false);
    }
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void upload(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  return (
    <div className="space-y-3">
      {/*
        The drop zone is presentation only — the real control is the labelled
        file input inside it. A div with an onDrop handler is invisible to a
        keyboard, so the button below is what actually has to work.
      */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-border',
        )}
      >
        <FileUp className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium">Drop a scan here, or choose a file</p>
          <p className="mt-1 text-xs text-muted-foreground">
            PDF, PNG, JPEG, or WebP — up to 25MB. Uzbek (Latin and Cyrillic) and
            Russian are recognised.
          </p>
        </div>

        <input
          ref={inputRef}
          id="scan-file"
          type="file"
          accept={ACCEPTED.join(',')}
          onChange={handleChange}
          disabled={uploading}
          className="sr-only"
        />
        <Button
          type="button"
          variant="outline"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Uploading…
            </>
          ) : (
            'Choose file'
          )}
        </Button>
      </div>

      {error ? <Alert variant="destructive">{error}</Alert> : null}
    </div>
  );
}
