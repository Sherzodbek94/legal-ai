import Link from 'next/link';
import { ArrowRight, Bot, FileText, Scale } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const stats = [
  { label: 'Open matters', value: '24', icon: Scale },
  { label: 'Documents in review', value: '61', icon: FileText },
  { label: 'Pending AI analyses', value: '7', icon: Bot },
];

export default function DashboardPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Matter activity and document intelligence across your workspace.
          </p>
        </div>
        <Button asChild>
          <Link href="/documents">
            Open document editor
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>

      <section aria-labelledby="overview-heading">
        <h2 id="overview-heading" className="sr-only">
          Workspace overview
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div
                key={stat.label}
                className="rounded-lg border border-border bg-card p-5"
              >
                <div className="flex items-center justify-between">
                  <dt className="text-sm text-muted-foreground">{stat.label}</dt>
                  <Icon
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </div>
                <dd className="mt-2 text-3xl font-semibold tracking-tight text-card-foreground">
                  {stat.value}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <section aria-labelledby="recent-heading" className="mt-10">
        <h2 id="recent-heading" className="mb-4 text-lg font-semibold tracking-tight">
          Recent documents
        </h2>
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {[
            { name: 'Mutual NDA — Northwind Systems', status: 'Analyzed' },
            { name: 'MSA Amendment No. 2 — Contoso', status: 'Processing' },
            { name: 'Engagement letter — Meridian', status: 'Uploaded' },
          ].map((doc) => (
            <li
              key={doc.name}
              className="flex items-center justify-between gap-3 px-5 py-4"
            >
              <Link
                href="/documents"
                className="min-w-0 truncate text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              >
                {doc.name}
              </Link>
              <Badge variant={doc.status === 'Analyzed' ? 'success' : 'secondary'}>
                {doc.status}
              </Badge>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
