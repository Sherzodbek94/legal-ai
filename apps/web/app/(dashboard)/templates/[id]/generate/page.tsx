import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Panel, PanelError } from '@/components/admin/panel';
import { GenerateForm } from '@/components/documents/generate-form';
import { apiGet } from '@/lib/api';
import { getSession } from '@/lib/session';
import { parseSchema } from '@/lib/variable-schema';
import { generateDocument } from './actions';

interface Template {
  id: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
}

interface PublishedVersion {
  id: string;
  version: number;
  variableSchema: unknown;
}

interface CompanyVariables {
  variables: Record<string, string>;
  missingRequired: string[];
}

interface BillingOverview {
  features: Record<string, boolean>;
}

export const metadata = { title: 'Generate document' };

export default async function GeneratePage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getSession();

  // One round trip's worth of latency instead of four: none of these depend on
  // each other, and issuing them sequentially would put three avoidable waits
  // on a page that is already behind a template lookup.
  const [template, version, billing, lookup] = await Promise.all([
    apiGet<Template>(`/templates/${params.id}`),
    apiGet<PublishedVersion>(`/templates/${params.id}/versions/published`),
    apiGet<BillingOverview>('/billing/overview'),
    apiGet<{ available: boolean }>('/counterparties/lookup/availability'),
  ]);

  if (!template.ok && template.status === 404) notFound();

  const companyVariables = session.company
    ? await apiGet<CompanyVariables>(`/companies/${session.company.id}/variables`)
    : null;

  const definitions = version.ok ? parseSchema(version.data.variableSchema) : [];

  // Only the fields this template actually declares. The profile carries more
  // than any one template needs, and pre-filling an undeclared key would have
  // the API reject the whole submission as an unknown variable.
  const declared = new Set(definitions.map((definition) => definition.key));
  const companyDefaults = Object.fromEntries(
    Object.entries(companyVariables?.ok ? companyVariables.data.variables : {})
      .filter(([key]) => declared.has(key)),
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <Link
          href="/templates"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Templates
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {template.ok ? template.data.name : 'Generate document'}
        </h1>
        {template.ok && template.data.description ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {template.data.description}
          </p>
        ) : null}
      </div>

      {!version.ok ? (
        <Panel title="Not available">
          {/* A template with no published version cannot generate anything —
              this is the API's own 409, not a broken page. */}
          <PanelError result={version} />
          <p className="px-5 pb-4 text-sm text-muted-foreground">
            Publish a version of this template before generating from it.
          </p>
        </Panel>
      ) : (
        <Panel
          title="Details"
          description={`Generating from version ${version.data.version}`}
        >
          <div className="px-5 py-4">
            <GenerateForm
              definitions={definitions}
              companyDefaults={companyDefaults}
              templateName={template.ok ? template.data.name : 'Document'}
              aiAvailable={billing.ok ? billing.data.features.aiGeneration === true : false}
              counterpartyLookupAvailable={lookup.ok ? lookup.data.available : false}
              action={generateDocument.bind(null, params.id, definitions)}
            />
          </div>
        </Panel>
      )}
    </div>
  );
}
