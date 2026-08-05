import { Building2 } from 'lucide-react';

/**
 * Shows the workspace the session is scoped to.
 *
 * Not a switcher, despite the name it kept. This previously rendered a dropdown
 * over three hardcoded companies — "Acme Legal LLP", "Harbor Counsel",
 * "Meridian Group" — none of which existed, and selecting one changed nothing.
 *
 * The data model has one company per session: the JWT carries a single
 * `companyId`, and every tenant-scoped query reads it from there. Switching
 * workspaces would mean re-issuing a token, which is a real feature and not one
 * that exists. Showing a control that implies otherwise is worse than showing a
 * label, so this is a label until that feature is built.
 */
export function WorkspaceSwitcher({
  companyName,
}: {
  companyName: string | null;
}) {
  if (!companyName) return null;

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border px-3 py-1.5">
      <Building2
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="truncate text-sm font-medium" title={companyName}>
        {companyName}
      </span>
    </div>
  );
}
