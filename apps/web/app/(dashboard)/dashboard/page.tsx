import Link from 'next/link';
import { ArrowRight, FileText, Clock, CheckCircle2, LibraryBig } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { apiGet } from '@/lib/api';
import { formatDate, formatNumber } from '@/lib/format';
import { DOCUMENT_STATUS_TONE } from '@/lib/document-status';

interface DocumentRow {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

interface UsageRow {
  metric: string;
  used: number;
  limit: number | null;
  remaining: number | null;
}

export const metadata = { title: 'Dashboard' };

/**
 * The workspace overview.
 *
 * Every figure here is counted from `/documents`, which returns this
 * company's documents and nothing else. This page previously rendered
 * invented numbers — "24 open matters, 61 documents in review, 7 pending AI
 * analyses" — none of which came from anywhere, on top of three fabricated
 * document names. "Open matters" was fabricated twice over: there is no
 * Matter model in the schema at all.
 */
export default async function DashboardPage() {
  const [documents, usage] = await Promise.all([
    apiGet<DocumentRow[]>('/documents'),
    apiGet<UsageRow[]>('/billing/usage'),
  ]);

  if (!documents.ok) {
    return (
      <div className="mx-auto w-full max-w-6xl animate-rise-in space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <Alert variant="destructive" title="Could not load your workspace">
          {documents.status > 0 ? `${documents.status}: ` : ''}
          {documents.message}
        </Alert>
      </div>
    );
  }

  const rows = documents.data;
  const awaitingApproval = rows.filter((row) => row.status === 'PENDING_APPROVAL').length;
  const completed = rows.filter(
    (row) => row.status === 'COMPLETED' || row.status === 'FINALIZED',
  ).length;
  const drafts = rows.filter(
    (row) => row.status === 'DRAFT' || row.status === 'GENERATED',
  ).length;

  const generationQuota = usage.ok
    ? usage.data.find((row) => row.metric === 'DOCUMENTS_GENERATED')
    : undefined;

  const stats = [
    { label: 'Total documents', value: rows.length, icon: FileText },
    { label: 'Awaiting approval', value: awaitingApproval, icon: Clock },
    { label: 'Completed', value: completed, icon: CheckCircle2 },
    { label: 'Drafts', value: drafts, icon: LibraryBig },
  ];

  const recent = rows.slice(0, 5);

  return (
    <div className="mx-auto w-full max-w-6xl animate-rise-in space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Document activity across your workspace.
          </p>
        </div>
        <Button asChild>
          <Link href="/templates">
            Generate a document
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>

      <section aria-labelledby="overview-heading">
        <h2 id="overview-heading" className="sr-only">
          Workspace overview
        </h2>
        <dl className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-center justify-between">
                  <dt className="text-sm text-muted-foreground">{stat.label}</dt>
                  <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <dd className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-card-foreground">
                  {formatNumber(stat.value)}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      {/*
        Surfaced on the overview rather than only on the billing page: hitting
        a generation quota mid-draft is the kind of thing worth knowing before
        starting, not at the moment of refusal.
      */}
      {generationQuota &&
      generationQuota.limit !== null &&
      generationQuota.remaining !== null &&
      generationQuota.remaining <= Math.max(2, generationQuota.limit * 0.1) ? (
        <Alert variant="warning" title="You are close to your generation limit">
          {formatNumber(generationQuota.remaining)} of{' '}
          {formatNumber(generationQuota.limit)} document generations left this period.{' '}
          <Link href="/billing" className="font-medium underline underline-offset-4">
            View billing
          </Link>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Recent documents</CardTitle>
            <CardDescription>The five most recently created.</CardDescription>
          </div>
          <Link
            href="/documents"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            View all
          </Link>
        </CardHeader>

        {recent.length === 0 ? (
          <CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">No documents yet.</p>
            <Button asChild variant="outline" className="mt-4">
              <Link href="/templates">Generate your first document</Link>
            </Button>
          </CardContent>
        ) : (
          <ul className="stagger divide-y divide-border">
            {recent.map((document) => (
              <li
                key={document.id}
                className="flex items-center justify-between gap-3 px-5 py-4"
              >
                <div className="min-w-0">
                  <Link
                    href={`/documents/${document.id}`}
                    className="block truncate text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {document.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatDate(document.createdAt)}
                  </p>
                </div>
                <Badge variant={DOCUMENT_STATUS_TONE[document.status] ?? 'outline'}>
                  {document.status.replace(/_/g, ' ').toLowerCase()}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
