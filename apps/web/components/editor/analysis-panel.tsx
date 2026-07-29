import { AlertTriangle, CalendarClock, FileSearch, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

interface Finding {
  id: string;
  title: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

const findings: Finding[] = [
  {
    id: 'f-1',
    title: 'Unilateral indemnity',
    detail:
      'Section 4 obligates only the receiving party to indemnify. Consider making the clause mutual.',
    severity: 'high',
  },
  {
    id: 'f-2',
    title: 'Survival period below policy',
    detail:
      'Confidentiality survives 3 years; internal policy requires a 5 year minimum for NDAs.',
    severity: 'medium',
  },
  {
    id: 'f-3',
    title: 'Governing law unspecified',
    detail: 'No governing law or venue clause was detected in this draft.',
    severity: 'low',
  },
];

const severityVariant = {
  high: 'destructive',
  medium: 'warning',
  low: 'secondary',
} as const;

export function AnalysisPanel() {
  return (
    <section
      aria-labelledby="analysis-heading"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <FileSearch className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2 id="analysis-heading" className="text-sm font-semibold">
          AI Analysis
        </h2>
        <Badge variant="secondary" className="ml-auto">
          3 findings
        </Badge>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Summary
          </h3>
          <p className="text-sm leading-6 text-foreground">
            A mutual NDA with a three-year survival period. Obligations are
            broadly standard, but the indemnity is one-sided and no governing law
            is specified.
          </p>
        </div>

        <Separator />

        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Risk findings
          </h3>
          <ul className="space-y-3">
            {findings.map((finding) => (
              <li
                key={finding.id}
                className="rounded-lg border border-border bg-card p-3"
              >
                <div className="mb-1.5 flex items-start justify-between gap-2">
                  <h4 className="text-sm font-medium text-card-foreground">
                    {finding.title}
                  </h4>
                  <Badge variant={severityVariant[finding.severity]}>
                    <span className="sr-only">Severity: </span>
                    {finding.severity}
                  </Badge>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">
                  {finding.detail}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <Separator />

        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Extracted terms
          </h3>
          <dl className="space-y-2.5 text-sm">
            <div className="flex items-start gap-2">
              <CalendarClock
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <dt className="w-28 shrink-0 text-muted-foreground">Survival</dt>
              <dd className="text-foreground">3 years</dd>
            </div>
            <div className="flex items-start gap-2">
              <ShieldCheck
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <dt className="w-28 shrink-0 text-muted-foreground">Mutuality</dt>
              <dd className="text-foreground">Partial</dd>
            </div>
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <dt className="w-28 shrink-0 text-muted-foreground">Governing law</dt>
              <dd className="text-foreground">Not specified</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
