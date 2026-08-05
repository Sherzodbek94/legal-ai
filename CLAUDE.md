# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run setup            # fresh clone → running, seeded database (compose up, migrate, seed)
npm run dev              # api on :4000, web on :3000
npm run build            # turbo build across all workspaces
npm run lint             # turbo lint
npm run test             # unit + integration. No database or network required.
```

Single test, or a single file:

```bash
cd apps/api && npx jest src/modules/auth              # one directory
cd apps/api && npx jest devsms.service.spec.ts        # one file
cd apps/api && npx jest -t "refuses to send"          # one test by name
cd apps/web && npx jest                               # web tests (lib only)
```

Anything needing real infrastructure is a separate command, because the default
suite deliberately needs none:

```bash
npm run test:e2e            # API against a REAL Postgres. Needs: docker compose up -d postgres-test redis
npm run test:e2e:browser    # Playwright. Needs the full stack running and seeded.
npm run dev:e2e             # the stack as Playwright needs it — disables the login throttle
npm run test:load           # k6, a standalone binary (see tests/load/README)
```

Database work always goes through the root scripts, never `prisma` directly:

```bash
npm run db:migrate     # create + apply a migration
npm run db:deploy      # apply existing migrations (CI, production)
npm run db:seed
npm run db:studio
npm run db:reset       # deploy + seed
```

Prisma resolves its CWD to `packages/database` and only looks for a `.env`
there, so it never sees the repository root `.env` these scripts document.
`dotenv-cli` in the root script is what bridges that; calling `npx prisma`
by hand fails with "Environment variable not found: DATABASE_URL".

## Requirements that are not optional

- **PostgreSQL 16 with `pgvector`.** The schema declares `vector(1536)` columns
  and the first migration fails without the extension. Use the
  `pgvector/pgvector:pg16` image; a stock `postgres:16` will not do.
- **Redis 7.** OTP challenges, OneID CSRF state, BullMQ queues and the
  Socket.IO adapter all depend on it. A pod that cannot reach Redis cannot log
  anyone in, which is why readiness fails on it and liveness does not.
- Embeddings must produce **1536** dimensions. Changing the model requires a
  migration and a full re-embed.

## Architecture

Turborepo with three workspaces: `apps/api` (NestJS 11), `apps/web` (Next.js 14
App Router), `packages/database` (Prisma schema + generated client, consumed by
both). Infrastructure manifests live in `infra/`.

The product is document *generation*, not matter management: a company keeps a
versioned template library, the AI drafts from a template plus supplied
variables, and the result moves through an approval chain before it is
finalised. `docs/prd.md` is reconciled against the implementation and is the
place to start.

### Things that span several files

- **Tenancy.** Every tenant-owned row carries `companyId` and composite indexes
  lead with it. Reads filter by tenant *in the query*, never after. Roles live
  on `CompanyMember`, not on `User` — one person holds different roles in
  different companies. `SUPER_ADMIN` on `User` is the platform operator and is
  not a company member.
- **Config.** `apps/api/src/config/` holds two pieces that both run at boot and
  must be kept in sync with the code that reads settings:
  - `numeric-config.ts` — everything read with `config.get<number>(...)` must
    be listed in `NUMERIC_KEYS`, or the caller receives a string where it
    believes it has a number. The file carries the grep that finds them.
  - `env.validation.ts` — refuses to boot on a broken environment. Add a rule
    here when a new setting has a range something downstream depends on, or
    when a new integration's credentials only work as a set.
- **Fail closed.** An integration with missing credentials reports itself
  unconfigured and its routes answer 503; it never half-works. `/auth/providers`
  drives which sign-in buttons the UI offers, so a half-set provider would put
  a button in front of a flow that cannot complete.
- **Delivery failures are classified, not just thrown.**
  `notification/providers/delivery-error.ts` splits every failure into
  `transient` / `permanent` / `misconfigured`. Retrying a permanent failure
  burns the retry budget and, for SMS, costs money per attempt. New providers
  classify before they throw.
- **Money is integer minor units.** Never floats. `PaymentTransaction` is an
  immutable ledger — corrections are new rows.
- **Idempotency** comes from unique constraints, not check-then-insert, which
  two concurrent requests can both pass.
- **Policy in code, not data.** Plan limits, the event catalogue and the
  taxonomy live in source so they are reviewable and revertible.
- **PII redaction.** Identifiers in template values are replaced with
  placeholders before any prompt leaves the process and restored into the
  answer. On unless `AI_REDACT_PII` is exactly `false`.
- **Soft delete** via `deletedAt` on mutable records; deliberately absent from
  `AuditLog` and `PaymentTransaction`, which must not be editable or hideable,
  and from `RefreshToken`, where `revokedAt` already models invalidation.

### Web

`apps/web/lib` holds the pure logic — formatting, template ↔ TipTap
conversion, variable-schema parsing, API error unwrapping — and is the only
part currently under test. Several of those files intentionally mirror an API
counterpart (`variable-schema.ts`, `collectPlaceholders`); the API stays the
authority and re-validates, so a drift produces a rejected form rather than a
bad document.

API errors arrive nested one level deeper than they look: `AllExceptionsFilter`
puts the thrown response inside `message`, so reading `body.message` alone
yields an object. Use `readApiError` / the `lib/api.ts` helpers.

## Conventions

- **Comments explain why, and what breaks otherwise.** The existing ones name
  the failure they prevent, often with the symptom it produced. Match that
  register — a comment restating the code is worse than none.
- **`//`-prefixed keys in `package.json`** are deliberate documentation for the
  script beneath them. Keep them current when changing a script.
- **Tests assert behaviour, not shape.** Cases are chosen for the failure they
  catch; the comment above a test usually says what that failure costs.
- CI (`.github/workflows/deploy.yml`) triggers on **`master`** — the repository
  has no `main`. Naming a branch that does not exist skips every job silently,
  which reads exactly like a green build.
