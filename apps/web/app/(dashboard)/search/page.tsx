import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Panel, PanelError } from '@/components/admin/panel';
import { apiGet } from '@/lib/api';

interface SearchHit {
  documentId: string;
  originalName: string;
  chunkId: string;
  chunkIndex: number;
  page: number | null;
  snippet: string;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  matchedBoth: boolean;
  semanticSimilarity: number | null;
  alsoMatched: { chunkId: string; chunkIndex: number; snippet: string }[];
}

interface SearchResponse {
  query: string;
  hits: SearchHit[];
  retrievers: { lexical: boolean; semantic: boolean };
  relaxed: boolean;
  tookMs: number;
}

export const metadata = { title: 'Search' };

export default async function SearchPage({
  searchParams,
}: {
  searchParams?: { q?: string; mode?: string };
}) {
  const query = searchParams?.q?.trim() ?? '';
  const mode = searchParams?.mode ?? 'hybrid';

  const results = query
    ? await apiGet<SearchResponse>(
        `/search?q=${encodeURIComponent(query)}&mode=${encodeURIComponent(mode)}`,
      )
    : null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Searches extracted document text by both wording and meaning.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3" action="/search">
        <div className="min-w-0 flex-1">
          <label htmlFor="q" className="mb-1 block text-xs text-muted-foreground">
            Query — Uzbek, Russian, or English
          </label>
          <input
            id="q"
            name="q"
            defaultValue={query}
            placeholder="shartnoma, договор поставки, termination notice"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label htmlFor="mode" className="mb-1 block text-xs text-muted-foreground">
            Mode
          </label>
          <select
            id="mode"
            name="mode"
            defaultValue={mode}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="hybrid">Hybrid</option>
            <option value="lexical">Keywords only</option>
            <option value="semantic">Meaning only</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Search
        </button>
      </form>

      {!query ? (
        <Panel title="Results">
          <EmptyState message="Enter a query to search your documents." />
        </Panel>
      ) : !results?.ok ? (
        <Panel title="Results">
          {results ? <PanelError result={results} /> : null}
        </Panel>
      ) : (
        <Panel
          title="Results"
          description={`${results.data.hits.length} match(es) in ${results.data.tookMs}ms`}
        >
          {/*
            Which retrievers ran is shown deliberately. Semantic search is
            skipped when OPENAI_API_KEY is unset, and without this the results
            look simply worse rather than explaining why.
          */}
          <div className="flex flex-wrap gap-2 border-b border-border px-5 py-3">
            <Badge variant={results.data.retrievers.lexical ? 'secondary' : 'outline'}>
              Keywords {results.data.retrievers.lexical ? 'on' : 'off'}
            </Badge>
            <Badge variant={results.data.retrievers.semantic ? 'secondary' : 'outline'}>
              Meaning {results.data.retrievers.semantic ? 'on' : 'off'}
            </Badge>
            {results.data.relaxed ? (
              <Badge variant="warning">
                Broadened — no document contained every term
              </Badge>
            ) : null}
          </div>

          {results.data.hits.length === 0 ? (
            <EmptyState
              message={
                results.data.retrievers.semantic
                  ? 'Nothing matched. Try fewer or different terms.'
                  : 'Nothing matched. Semantic search is off — set OPENAI_API_KEY to search by meaning as well as wording.'
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {results.data.hits.map((hit) => (
                <li key={hit.chunkId} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium">{hit.originalName}</h3>
                    <div className="flex items-center gap-1.5">
                      {/* Found by both retrievers is the strongest signal hybrid
                          search produces, so it is surfaced rather than buried
                          in the score. */}
                      {hit.matchedBoth ? (
                        <Badge variant="success">Strong match</Badge>
                      ) : null}
                      {hit.page !== null ? (
                        <span className="text-xs text-muted-foreground">
                          p.{hit.page}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {hit.snippet}
                  </p>

                  {hit.alsoMatched.length > 0 ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        {hit.alsoMatched.length} more passage(s) in this document
                      </summary>
                      <ul className="mt-1 space-y-1 border-l border-border pl-3">
                        {hit.alsoMatched.map((extra) => (
                          <li key={extra.chunkId} className="text-xs text-muted-foreground">
                            {extra.snippet}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <p className="text-xs text-muted-foreground">
        Only documents uploaded for text extraction are searchable.{' '}
        <Link href="/scans" className="font-medium underline underline-offset-4">
          Upload a scan
        </Link>{' '}
        to add one — image-only PDFs are rasterised and OCR&rsquo;d automatically.
      </p>
    </div>
  );
}
