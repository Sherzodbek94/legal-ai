import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ScanUploader } from '@/components/documents/scan-uploader';
import { apiGet } from '@/lib/api';
import { formatDate } from '@/lib/format';

interface ScanRow {
  id: string;
  originalName: string;
  status: string;
  confidence: number | null;
  extractionMethod: string | null;
  pageCount: number | null;
  languages: string[];
  createdAt: string;
  completedAt: string | null;
  _count: { chunks: number };
}

export const metadata = { title: 'Scans' };

const STATUS_TONE: Record<string, 'secondary' | 'success' | 'warning' | 'destructive'> = {
  PENDING: 'secondary',
  PROCESSING: 'secondary',
  COMPLETED: 'success',
  // Not a failure: the text is stored and searchable, just flagged for review.
  LOW_CONFIDENCE: 'warning',
  FAILED: 'destructive',
};

/**
 * Scanned document ingestion.
 *
 * OCR is advertised on the landing page and fully implemented in the API
 * (`POST /search/documents` → Tesseract, with `pdftoppm` rasterisation for
 * image-only PDFs), but there was previously no file input anywhere in the
 * app — the feature was unreachable through the UI.
 */
export default async function ScansPage() {
  const scans = await apiGet<ScanRow[]>('/search/documents');

  return (
    <div className="mx-auto w-full max-w-6xl animate-rise-in space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload scanned contracts and correspondence. Extracted text becomes
          searchable from{' '}
          <Link href="/search" className="font-medium underline underline-offset-4">
            Search
          </Link>
          .
        </p>
      </div>

      <ScanUploader />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Uploaded documents</CardTitle>
            <CardDescription>
              Extraction runs in the background; status updates on refresh.
            </CardDescription>
          </div>
        </CardHeader>

        {!scans.ok ? (
          <div className="p-5">
            <Alert variant="destructive" title="Could not load your scans">
              {scans.status > 0 ? `${scans.status}: ` : ''}
              {scans.message}
            </Alert>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Pages</TableHead>
                <TableHead>Languages</TableHead>
                <TableHead>Indexed</TableHead>
                <TableHead>Uploaded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scans.data.length === 0 ? (
                <TableEmpty
                  colSpan={6}
                  message="Nothing uploaded yet. Add a scan above to make it searchable."
                />
              ) : (
                scans.data.map((scan) => (
                  <TableRow key={scan.id}>
                    <TableCell className="font-medium">{scan.originalName}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_TONE[scan.status] ?? 'outline'}>
                        {scan.status.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      {/* A confidence figure only means something for a real
                          OCR pass — a PDF text layer is exact, not estimated. */}
                      {scan.confidence !== null ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {Math.round(scan.confidence)}%
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular-nums">{scan.pageCount ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {scan.languages.length > 0 ? scan.languages.join(', ') : '—'}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {scan._count.chunks > 0 ? `${scan._count.chunks} passages` : '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(scan.createdAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
