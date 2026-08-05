import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import {
  TemplateBuilder,
  type CategoryOption,
} from '@/components/templates/template-builder';
import { apiGet } from '@/lib/api';
import { getSession } from '@/lib/session';

export const metadata = { title: 'New template' };

interface CategoryNode {
  id: string;
  name: string;
  path: string;
  depth: number;
  children: CategoryNode[];
}

/**
 * Only leaf categories are offered.
 *
 * The taxonomy's branches are groupings; a template belongs to the specific
 * activity at the bottom, and filing one against "Contracts" rather than
 * "Supply of goods" is how the catalogue stops being navigable.
 */
function leafCategories(nodes: CategoryNode[]): CategoryOption[] {
  const leaves: CategoryOption[] = [];

  const walk = (node: CategoryNode) => {
    if (node.children.length === 0) {
      leaves.push({
        id: node.id,
        name: node.name,
        // The full path disambiguates the several "General" leaves a
        // 288-node taxonomy inevitably contains.
        path: node.path
          .split('/')
          .filter(Boolean)
          .join(' › '),
      });
      return;
    }
    node.children.forEach(walk);
  };

  nodes.forEach(walk);
  return leaves;
}

export default async function NewTemplatePage() {
  const [tree, session] = await Promise.all([
    apiGet<CategoryNode[]>('/taxonomy/tree'),
    getSession(),
  ]);

  // Authoring is an owner/admin action; the API enforces it with @Roles, this
  // only avoids rendering a form that would be refused on submit.
  const role = session.user?.companyRole;
  if (role !== 'OWNER' && role !== 'ADMIN') {
    redirect('/templates');
  }

  const categories = tree.ok ? leafCategories(tree.data) : [];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <Link
          href="/templates"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Templates
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New template</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Templates are versioned and immutable once published; editing later
          creates a new version rather than changing this one.
        </p>
      </div>

      {!tree.ok ? (
        <Alert variant="destructive" title="Could not load the taxonomy">
          {tree.status > 0 ? `${tree.status}: ` : ''}
          {tree.message}
        </Alert>
      ) : categories.length === 0 ? (
        <Alert variant="warning" title="No categories available">
          The taxonomy is empty, so there is nowhere to file a template. Run{' '}
          <code>npm run db:seed</code> to load it.
        </Alert>
      ) : (
        <TemplateBuilder categories={categories} />
      )}
    </div>
  );
}
