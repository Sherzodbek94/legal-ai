import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  EmptyState,
  Panel,
  PanelError,
  TableScroll,
  Td,
  Th,
} from '@/components/admin/panel';
import { PublishButton } from '@/components/templates/publish-button';
import { apiGet } from '@/lib/api';
import { getSession } from '@/lib/session';
import { formatDate, formatNumber } from '@/lib/format';

interface TemplateRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  version: number;
  currentVersionId: string | null;
  createdAt: string;
  taxonomy: { id: string; name: string; path: string; kind: string } | null;
}

interface TemplateList {
  items: TemplateRow[];
  nextCursor: string | null;
}

interface CategoryNode {
  id: string;
  name: string;
  kind: string;
  depth: number;
  templateCount: number;
  totalTemplateCount: number;
  children: CategoryNode[];
}

export const metadata = { title: 'Templates' };

const KIND_LABELS: Record<string, string> = {
  CONTRACT: 'Contracts',
  HR_ORDER: 'HR orders',
  CORPORATE_ACT: 'Corporate acts',
};

export default async function TemplatesPage() {
  const [templates, tree, session] = await Promise.all([
    apiGet<TemplateList>('/templates'),
    apiGet<CategoryNode[]>('/taxonomy/tree'),
    getSession(),
  ]);

  const canManage =
    session.user?.companyRole === 'OWNER' || session.user?.companyRole === 'ADMIN';

  return (
    <div className="mx-auto w-full max-w-6xl animate-rise-in space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The document catalogue, filed by taxonomy. Versions are immutable —
            publishing a change creates a new one.
          </p>
        </div>
        {canManage ? (
          <Button asChild>
            <Link href="/templates/new">
              <Plus aria-hidden="true" />
              New template
            </Link>
          </Button>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Panel title="Taxonomy" description="Categories and their template counts">
          {!tree.ok ? (
            <PanelError result={tree} />
          ) : tree.data.length === 0 ? (
            <EmptyState message="No categories yet. A platform administrator can seed the catalogue." />
          ) : (
            <ul className="space-y-3 px-5 py-4">
              {tree.data.map((root) => (
                <li key={root.id}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">
                      {KIND_LABELS[root.kind] ?? root.name}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatNumber(root.totalTemplateCount)}
                    </span>
                  </div>
                  {root.children.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 border-l border-border pl-3">
                      {/* Groups only. The full tree is 288 leaves deep and would
                          make this panel unreadable. */}
                      {root.children.slice(0, 8).map((group) => (
                        <li
                          key={group.id}
                          className="flex items-baseline justify-between gap-2 text-xs"
                        >
                          <span className="truncate text-muted-foreground">
                            {group.name}
                          </span>
                          <span className="tabular-nums text-muted-foreground">
                            {formatNumber(group.totalTemplateCount)}
                          </span>
                        </li>
                      ))}
                      {root.children.length > 8 ? (
                        <li className="pt-1 text-xs text-muted-foreground">
                          + {root.children.length - 8} more
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="All templates"
          description={templates.ok ? `${templates.data.items.length} shown` : undefined}
        >
          {!templates.ok ? (
            <PanelError result={templates} />
          ) : templates.data.items.length === 0 ? (
            <EmptyState message="No templates yet. Run npm run db:seed for a sample." />
          ) : (
            <TableScroll>
              <table className="w-full">
                <thead className="border-b border-border">
                  <tr>
                    <Th>Template</Th>
                    <Th>Category</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Version</Th>
                    <Th>Created</Th>
                    <Th className="text-right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {templates.data.items.map((template) => (
                    <tr key={template.id}>
                      <Td>
                        <div className="font-medium">{template.name}</div>
                        {template.description ? (
                          <div className="max-w-md truncate text-xs text-muted-foreground">
                            {template.description}
                          </div>
                        ) : null}
                      </Td>
                      <Td className="text-muted-foreground">
                        {template.taxonomy?.name ?? '—'}
                      </Td>
                      <Td>
                        <Badge
                          variant={
                            template.status === 'PUBLISHED'
                              ? 'success'
                              : template.status === 'ARCHIVED'
                                ? 'outline'
                                : 'secondary'
                          }
                        >
                          {template.status}
                        </Badge>
                      </Td>
                      <Td className="text-right tabular-nums">v{template.version}</Td>
                      <Td className="whitespace-nowrap text-muted-foreground">
                        {formatDate(template.createdAt)}
                      </Td>
                      <Td className="text-right">
                        {/* Only published templates can generate — the API
                            returns 409 for the rest, so offering the link
                            would be an invitation to a dead end. */}
                        {template.status === 'PUBLISHED' ? (
                          <Link
                            href={`/templates/${template.id}/generate`}
                            className="text-sm font-medium text-primary hover:underline"
                          >
                            Generate
                          </Link>
                        ) : canManage && template.status === 'DRAFT' ? (
                          <PublishButton
                            templateId={template.id}
                            templateName={template.name}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Not published
                          </span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </Panel>
      </div>
    </div>
  );
}
