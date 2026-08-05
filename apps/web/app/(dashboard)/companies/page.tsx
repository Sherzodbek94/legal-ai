import {
  EmptyState,
  Panel,
  PanelError,
  TableScroll,
  Td,
  Th,
} from '@/components/admin/panel';
import { apiGet } from '@/lib/api';
import { formatDate } from '@/lib/format';

interface Company {
  id: string;
  name: string;
  slug: string;
  legalName: string | null;
  stir: string | null;
  oked: string | null;
  mfo: string | null;
  bankAccount: string | null;
  bankName: string | null;
  legalAddress: string | null;
  actualAddress: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  directorName: string | null;
  directorPosition: string | null;
  accountantName: string | null;
  createdAt: string;
}

export const metadata = { title: 'Company' };

/**
 * Company profile.
 *
 * These fields are not administrative trivia — they are what gets printed onto
 * every generated contract. `mapCompanyToVariables` turns them into prompt
 * variables, and four of them are required before a contract can be completed at
 * all, so a missing STIR is a blocked document rather than an empty field.
 */
export default async function CompaniesPage() {
  const companies = await apiGet<Company[]>('/companies');

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Company</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Registry details printed onto generated documents.
        </p>
      </div>

      {!companies.ok ? (
        <Panel title="Company profile">
          <PanelError result={companies} />
        </Panel>
      ) : companies.data.length === 0 ? (
        <Panel title="Company profile">
          <EmptyState message="No company on this account yet." />
        </Panel>
      ) : (
        companies.data.map((company) => (
          <div key={company.id} className="space-y-6">
            <Panel
              title={company.name}
              description={company.legalName ?? undefined}
            >
              <dl className="divide-y divide-border">
                <Row label="Legal name" value={company.legalName} required />
                <Row label="STIR (ИНН)" value={company.stir} required />
                <Row label="OKED (ОКЭД)" value={company.oked} />
                <Row label="Registered address" value={company.legalAddress} required />
                <Row label="Actual address" value={company.actualAddress} />
                <Row label="Created" value={formatDate(company.createdAt)} />
              </dl>
            </Panel>

            <Panel title="Banking">
              <dl className="divide-y divide-border">
                <Row label="Bank" value={company.bankName} />
                <Row label="MFO" value={company.mfo} />
                <Row
                  label="Settlement account"
                  value={
                    // Grouped in fours, the way Uzbek settlement accounts are
                    // conventionally read.
                    company.bankAccount
                      ? company.bankAccount.replace(/(\d{4})(?=\d)/g, '$1 ')
                      : null
                  }
                />
              </dl>
            </Panel>

            <Panel title="Representation">
              <dl className="divide-y divide-border">
                <Row label="Director" value={company.directorName} required />
                <Row label="Position" value={company.directorPosition} />
                <Row label="Chief accountant" value={company.accountantName} />
                <Row label="Phone" value={company.phone} />
                <Row label="Email" value={company.email} />
                <Row label="Website" value={company.website} />
              </dl>
            </Panel>
          </div>
        ))
      )}

      <p className="text-xs text-muted-foreground">
        Fields marked <span className="text-destructive">required</span> must be
        present before a contract can complete its approval chain — generation
        refuses rather than producing a document with a blank party.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  required,
}: {
  label: string;
  value: string | null;
  required?: boolean;
}) {
  const missing = !value;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
      <dt className="text-sm text-muted-foreground">
        {label}
        {required && missing ? (
          <span className="ml-2 text-xs text-destructive">required</span>
        ) : null}
      </dt>
      <dd
        className={`text-sm ${missing ? 'text-muted-foreground' : 'font-medium'}`}
      >
        {value ?? 'Not set'}
      </dd>
    </div>
  );
}
