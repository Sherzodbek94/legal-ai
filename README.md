# LegalTech SaaS

AI-assisted legal document generation, review, and approval for law firms and
in-house teams, built for the Uzbekistan market — Uzbek/Russian document
handling, local payment gateways, and OneID authentication.

- **`apps/api`** — NestJS 11 REST API, Socket.IO gateway, BullMQ workers
- **`apps/web`** — Next.js 14 (App Router) dashboard
- **`packages/database`** — Prisma schema and generated client, shared by both
- **`infra/`** — Kubernetes manifests and nginx configuration

---

## Requirements

| Tool           | Version   | Notes                                              |
| -------------- | --------- | -------------------------------------------------- |
| Node.js        | ≥ 18.18   | 22 LTS is what the Docker images use               |
| npm            | ≥ 10      | Workspaces; the repo pins npm 11 via `packageManager` |
| PostgreSQL     | 16        | **Must have the `pgvector` extension**             |
| Redis          | ≥ 7       | Sessions, OTP, BullMQ queues, Socket.IO adapter    |

`pgvector` is not optional — the schema declares `vector(1536)` columns and the
first migration fails without it. The simplest way to get a correct database
locally:

```bash
docker run -d --name legaltech-db \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=legaltech \
  -p 5432:5432 pgvector/pgvector:pg16

docker run -d --name legaltech-redis -p 6379:6379 redis:7-alpine
```

---

## Setup

```bash
git clone <repository-url> legaltech-saas
cd legaltech-saas

npm install
cp .env.example .env

npm run setup               # starts Postgres + Redis, migrates, seeds
npm run dev                 # api on :4000, web on :3000
```

`npm run setup` runs `docker compose up -d`, waits for Postgres to genuinely
accept connections, generates the Prisma client, applies every migration, and
seeds demo data. From a clean clone that is the only command needed.

### Demo accounts

Created by the seed. Same password for all three:

| Account | Email | Purpose |
| --- | --- | --- |
| Owner | `owner@acme-legal.uz` | Company owner — billing, templates |
| Attorney | `attorney@acme-legal.uz` | Second approver |
| Super admin | `admin@legaltech.uz` | `/admin` — required for those routes |

Password: `DemoPassw0rd!`

The attorney exists because a document cannot be approved by whoever submitted
it — a single-user company can never complete an approval chain.

The seed refuses to run against a non-localhost `DATABASE_URL` unless
`ALLOW_REMOTE_SEED=true` is set, because it writes known-password accounts.

### Sign-in methods

Four, all reaching the same session — HTTPOnly cookies with a rotating refresh
token. `/login` and `/register` render only the ones the deployment can
actually perform, read once per page from `GET /auth/providers`; a button that
only discovers it is unconfigured when clicked reads as a fault rather than as
a method that was never on offer.

| Method | Configured by | Identity bound to |
| --- | --- | --- |
| Password | always available | `User.email` |
| SMS code | `ESKIZ_*` | `User.phone`, unique and verified |
| Google | `GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | `User.googleSubject` |
| OneID | `ONEID_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | `User.oneIdSubject` |

Each federated method binds the provider's stable subject on first use, not the
email address. Matching on email alone would let anyone who can get a provider
to assert someone else's address take over that account; an email that already
belongs to a different identity is refused rather than annexed.

A correct SMS code **is** the sign-in — the API mints a session directly rather
than stopping at "verified", because the number is unique and proven by
possession. A first sign-in from a number nobody holds creates the account, so
`User.email` is nullable: a phone-only or Google-only account is a real one.

Without an SMS gateway, a non-production build logs the code at `warn` instead
of sending it, and `/auth/providers` still reports SMS as available. In
production the same path refuses to issue a code it cannot deliver rather than
leaving the user at a code box waiting for a message that is not coming.

Both redirect URIs must carry the API's `/api` prefix — `ONEID_REDIRECT_URI`
did not, and pointed at a 404.

### Legislation corpus

Uzbek statute law, indexed so an answer can cite the article it rests on.

Two corpora, deliberately separate. `document_chunks` holds each tenant's own
uploaded scans — private, cited by page. `legal_acts` / `legal_act_chunks` hold
the statute book — shared by every tenant, cited by article, and carrying a
force status. Giving each tenant a private copy of the law would multiply the
embedding bill by the customer count and make "is this article in force" a
question with different answers per tenant.

Chunked on **article boundaries**, not at a fixed token count. An article is
the unit a lawyer cites, so a chunk that corresponds to one produces a citation
that is exact rather than approximate. `splitIntoArticles` reads all four forms
that occur — `347-modda`, `347-модда`, `Статья 347`, `Article 347` — preserves
inserted articles (`347-1` is a different provision from `347`), and refuses to
split on a cross-reference inside a sentence.

Three behaviours worth knowing:

- **An article named in the query is a lookup, not a ranking guess.** Searching
  `347-modda` used to rank article *348* first, because 348 opens by referring
  to 347 and cover density rewards that. A bare `347` is deliberately ignored —
  it is far more often a sum of money than a citation.
- **The semantic half may fail without taking the search down.** An expired key
  or a rate limit costs the query its vector recall; the lexical half answers
  from a local index, and `retrievers.semantic` reports what actually ran.
- **Repealed acts are surfaced, not hidden.** A superseded provision is often
  exactly what someone researching a historic contract needs. Every hit carries
  `superseded`; `inForceOnly=true` filters if you want. An unrecognised status
  maps to `UNKNOWN`, never `IN_FORCE`.

Ingest with `POST /api/legal-corpus/ingest` (platform administrators only — it
rewrites data every customer reads and spends real money on embeddings). Runs
are resumable and cheap to repeat: acts commit one at a time, and one whose
`revision` is unchanged is skipped before anything is chunked or embedded.

Source is `LEGAL_CORPUS_DIR`. On why this repository ships no lex.uz scraper,
see that variable in `.env.example` and *Known gaps*.

### Legal chat

`POST /api/chat/ask` answers a question from retrieved sources rather than from
the model's memory. Both corpora are searched: the shared statute book (cited by
article) and the asking company's own scans (private, cited by document), merged
into one numbered list.

**Sources are numbered `[S1]`…`[Sn]`, not named, and that is the point.** A model
that invents "347-modda" produces something a lawyer cannot distinguish from a
real citation. A model that invents `[S9]` when it was handed six sources is
caught by counting. `checkCitations` splits what the answer cited into *real*
and *invented*; `stripInvented` removes the dangling markers before the answer
is shown, because a footnote pointing at nothing reads as though a source exists
and the UI failed to render it.

`ungrounded` is set when nothing was retrieved, or when the model cited nothing
it was given — both mean the answer is the model's own opinion, and that has to
be visible rather than inferred from an empty list.

Verified against a live model: asked about set-off it answered correctly citing
articles 347 and 348; asked about customs declarations, which the corpus does
not cover, it answered *"Berilgan manbalarda bu savolga javob yo'q"* and named
what the sources did contain instead of inventing a deadline.

Four sources from the corpus and two from the company's documents, not twenty:
a model handed twenty answers from the two it liked rather than the one that was
relevant, while the caller pays for all twenty.

The question and the retrieved scans go through the same PII redaction as
document generation — a question routinely carries a client's passport, and an
uploaded contract carries an account number.

### Drafting a template with AI

The templates this product shipped with were skeletons — a heading, a contract
number, a payment line. A contract generated from one had no subject clause, no
obligations, no liability, no force majeure, no dispute forum. That is not a
contract; it is a letterhead.

`POST /api/ai-engine/draft-template` produces a real one. Give it a document
type ("tovar yetkazib berish shartnomasi") and optional requirements; it returns
editor content, a variable schema, and a list of problems with itself.

**A template is not a document, and asking for one is a different request.** A
document is finished text; a template is text with holes plus a declaration of
what fills each hole. Asking the model for a document and hunting for the
variable-shaped parts afterwards does not work — it invents a party name, and
nothing downstream can tell that "ACME LEGAL MCHJ" was meant to be a
placeholder. So the model declares both halves in one answer and
`validateTemplateDraft` checks they agree:

- **`undeclared`** — a `{{placeholder}}` no variable declares. This is the one
  that matters: it survives into a generated contract and prints literally on a
  page somebody signs.
- **`unused`** — declared, never used. Harmless, but asks the user for nothing.
- **`invalidKeys`** — keys the forms and exporters cannot address.
- **`thinSections`** — a clause under 120 characters. Precisely the defect being
  fixed here, so it is measured rather than hoped for.

Issues are **returned, not thrown**. The draft is a proposal a human reviews in
the builder, and losing an otherwise good template over one spare variable would
be the worse outcome.

The system prompt names the eleven clauses an Uzbek commercial contract is
conventionally built from, as a requirement rather than a suggestion — a model
asked for "a supply contract" without that list reliably returns three
paragraphs. Headings are renumbered from `order` on the way in, because models
number inconsistently across a long answer and clauses running 1, 2, 2, 4 read
as the firm's mistake rather than the software's.

OWNER and ADMIN only: a template is shared by everyone in the workspace and
every document generated from it inherits its clauses, so authoring one is not
the same permission as drafting a document from one.

### Editing a document

A generated document used to be immutable: created, approved, exported. Real
drafting is not that — a clause gets reworded, a date corrected, an annex added
— and with no edit path every correction meant regenerating from the template
and losing the work.

`PATCH /api/documents/:id` saves an edit. The body is TipTap JSON, the same
shape the generator writes and the PDF and DOCX renderers read, so an edited
document exports through exactly the path a generated one does.

Three rules:

- **A document under approval cannot be edited.** PENDING_APPROVAL, COMPLETED,
  FINALIZED and GENERATING are refused with 409. Editing after approval silently
  converts other people's decisions into approval of text they never saw — the
  same class of failure as letting a submitter approve their own document, which
  this product already refuses. Withdraw, edit, resubmit. REJECTED *is* editable:
  that is the document somebody needs to correct.
- **Concurrent saves do not silently overwrite.** Every save carries
  `expectedRevision`; a mismatch answers 409 with the current revision so the
  client can say what happened. The write itself is conditional on the revision
  too, which is what catches two saves that both passed the check and raced.
- **Every state is kept.** The state being *displaced* is snapshotted, so the
  version list is the states the document passed through and the live row is the
  current one. Restore is an ordinary edit, so it snapshots first — restoring is
  itself undoable.

`GET /api/documents/:id/versions` lists them (bodies excluded — a version's
content is the whole document and the list is a sidebar), and
`POST /api/documents/:id/versions/:versionId/restore` puts one back.

The toolbar is deliberately short — headings, emphasis, lists, quotes. Every
control beyond that is one more way to produce a body `tiptap-to-docx` has no
mapping for and would silently drop.

### PII redaction

Document prompts carry whatever the template variables held — routinely a
counterparty's settlement account, a director's passport number, a client's
phone. None of it changes how a model drafts a clause: the wording is the same
whether the account is real or `[BANK_ACCOUNT_1]`. So identifiers are replaced
with placeholders before the request leaves this process, and the real values
are restored into the answer before it is parsed.

Detected: STIR, PINFL/JSHSHIR, passport, settlement account, payment card,
phone, email.

The hard part is not matching — it is **not** matching. Most Uzbek identifiers
are bare digit strings of a fixed length, and legal documents are full of digit
strings that are not identifiers. A detector keyed on "nine digits" would redact
the amount payable out of every contract it touched. So each pattern is anchored
on something more:

- a **label**, in all four spellings that occur (`STIR`, `СТИР`, `ИНН`, `h/r`,
  `р/с`, `ПИНФЛ`, …) for the otherwise-ambiguous ones;
- a **structural signature** where one exists — a passport's two letters, a
  phone's `+998`, an email's `@`;
- a **checksum** where one exists — Luhn, which is what makes a bare sixteen
  digit card safe to detect without a label.

A bare `305123456` is deliberately **not** detected. The bias is one-directional
on purpose: a missed identifier is a leak and a false positive is a redacted
contract number, and only the first is irreversible.

One value gets one placeholder throughout a document, so a model reasoning about
"the same account" does not see two. A placeholder the model invented is left
as-is rather than guessed at — a visible defect a reviewer catches beats an
invisible one where the nearest real value was silently substituted. Reports and
logs carry masked forms only (`*****3456`); nothing here returns a raw value.

Switch off with `AI_REDACT_PII=false`. Also exposed for review at
`GET /api/search/documents/:id/pii`, which lists what a scan is carrying before
it is exported or forwarded.

One trap worth recording: JavaScript's word-boundary escape is defined against
ASCII, so every Cyrillic letter counts as a *non-word* character to it. A
boundary-anchored pattern therefore never matches after a Cyrillic word — which
is exactly how a passport number typed in a Cyrillic keyboard layout arrives.
The patterns use explicit lookarounds over both alphabets instead.

### Counterparty lookup

A contract names two parties. The product modelled one of them in full —
seventeen `company_*` variables — while the other was a name typed into an
export query string. `GET /counterparties/lookup?stir=` closes that: it returns
the other side's registered details, pre-mapped to `counterparty_*` template
variables.

Configured by `IHAMKOR_API_KEY`. **iHamkor** is operated by DEFEN FINANCIAL LLC
under a public-private partnership contract (DXSh/52-2022) pursuant to Cabinet
of Ministers Resolution No. 529 of 19 August 2021 — the instrument that permits
taxpayer data to be released to third parties at all, which makes it the
sanctioned channel for this. Deliberately not orginfo.uz: that is one
developer's scrape of stat.uz open data with no API, and the Statistics
Committee filed a complaint against its founder in December 2021.

Three rules the implementation holds to:

- **Nothing is applied without confirmation.** A lookup returns a suggestion
  carrying its source and the time it was retrieved; the user presses *Use
  these details* before it reaches a form. Same rule as OneID's `legalEntities`
  prefill, because a wrong STIR in a signed contract is a liability.
- **"Not registered" and "could not check" stay distinct.** An unknown STIR
  answers `200 {found:false}`; a provider fault raises 503. Collapsing them
  would send a user with a correct STIR off editing a right answer.
- **No bank details.** MFO and the settlement account are not in the public
  register, so the mapper never emits them and the UI names the fields that
  still have to come from the counterparty.

An unrecognised registry status maps to `UNKNOWN`, never `ACTIVE` — showing a
liquidated company as trading is the one failure this feature exists to prevent.

The wire contract is unverified; see *Known gaps*.

### Minimum configuration to boot

`.env.example` documents every variable and why it exists. Only these four are
required to start the API:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/legaltech?schema=public"
REDIS_URL="redis://localhost:6379"

# Generate each with: openssl rand -base64 48
JWT_ACCESS_SECRET="…"
DOCUMENT_VERIFICATION_SECRET="…"   # minimum 32 characters; enforced in code
```

Everything else degrades gracefully. Without `ANTHROPIC_API_KEY` the AI engine
reports no configured provider; without `OPENAI_API_KEY` documents are indexed
for keyword search but not semantic search; without payment or notification
credentials those providers refuse to send rather than sending silently into a
void. **Every integration fails closed** — an unset secret never means "skip the
check".

---

## Commands

Run from the repository root; Turborepo fans them out across workspaces.

| Command                     | What it does                                        | Needs |
| --------------------------- | --------------------------------------------------- | --- |
| `npm run setup`             | Containers up, migrate, seed — one-command bootstrap | Docker |
| `npm run dev`               | API and web in watch mode                            | DB |
| `npm run dev:e2e`           | The same, with login throttling off for Playwright   | DB |
| `npm run build`             | Build every workspace                                | — |
| `npm run test`              | Unit and integration tests                           | — |
| `npm run test:e2e`          | API tests against a **real** Postgres                | Docker |
| `npm run test:e2e:browser`  | Playwright, in a real browser                        | `dev:e2e` |
| `npm run test:load`         | k6, 200 concurrent users                             | k6 + stack |
| `npm run test:all`          | `test` + `test:e2e`                                  | Docker |
| `npm run db:seed`           | Re-seed demo data                                    | DB |
| `npm run db:studio`         | Prisma Studio                                        | DB |
| `npm run lint`              | Lint every workspace                                 | — |
| `npm run clean`             | Remove build output and `node_modules`               | — |

Run a single test file:

```bash
cd apps/api && npx jest src/modules/billing/limits/quota-policy.spec.ts
npx jest -t "does not double-bill"        # by test name
```

### The four test layers

Each catches a different class of defect, which is why all four exist:

| Layer | Catches | Needs a database? |
| --- | --- | --- |
| **Jest unit** — `src/**/*.spec.ts` | Logic errors in isolation | No |
| **Jest e2e** — `test/*.e2e-spec.ts` | Cross-module and cross-tenant defects; **executes the real migrations** | Yes |
| **Playwright** — `tests/e2e/` | Cookies, CORS, Cyrillic glyphs in generated PDFs | Full stack |
| **k6** — `tests/load/` | Behaviour under 200 concurrent users | Full stack |

`npm run test` deliberately requires nothing — it runs everywhere, including in a
fresh clone. The layers that need infrastructure are separate commands so a
missing container is an explicit choice rather than a mysterious failure.

---

## Architecture

### Request path

```
Browser ──► nginx Ingress ──► /api  ──► NestJS   (apps/api)
                          └─► /     ──► Next.js  (apps/web)
                          └─► /socket.io ──► NestJS gateway
```

The API is mounted under a global `/api` prefix, **except** `/health/*` and
`/metrics`, which the kubelet and Prometheus reach directly on the pod.

### Guard order

Registered globally in `app.module.ts`, and the order is deliberate:

1. `ThrottlerGuard` — shed abusive load before doing any work
2. `JwtAuthGuard` — deny-by-default; routes opt out with `@Public()`
3. `RolesGuard` — tenant and platform role checks
4. `ImpersonationGuard` — blocks money and credential routes during support sessions
5. `PlanLimitGuard` — reserves plan quota, refunded by an interceptor if the handler throws

### Modules

| Module        | Responsibility                                                        |
| ------------- | --------------------------------------------------------------------- |
| `auth`        | JWT with rotating refresh tokens, SMS OTP, OneID (id.egov.uz)         |
| `company`     | Tenants, members, Uzbek registry identifiers (STIR/OKED/MFO)          |
| `counterparty`| Business-registry lookup of the other party to a contract (iHamkor)   |
| `legal-corpus`| Uzbek statute law, split by article, embedded, cited                  |
| `chat`        | Legal Q&A answered from retrieved sources, citations verified        |
| `template`    | 288-leaf taxonomy, immutable versions, multi-role approval chains     |
| `ai-engine`   | Claude primary with OpenAI failover, strict JSON-schema output        |
| `common/pii`  | Identifier detection; redaction before any prompt leaves the process  |
| `document`    | PDF via Puppeteer, native DOCX, HMAC-signed QR verification           |
| `ocr-search`  | Tesseract (Uzbek Latin/Cyrillic + Russian), hybrid vector + FTS search |
| `billing`     | Plans, quota enforcement, coupons, renewal crons                      |
| `payment`     | Click, Payme, Uzum, Stripe — idempotent webhooks                      |
| `notification`| BullMQ queues → Eskiz SMS, Telegram, email, in-app WebSocket          |
| `admin`       | MRR/ARR, account locking, AI cost tracking, audited impersonation     |
| `health`      | Terminus probes, Prometheus metrics, graceful shutdown                |

### Design rules used throughout

- **Multi-tenancy** — every tenant-owned row carries `companyId`, and composite
  indexes lead with it. Reads filter by tenant *in the query*, never after.
- **Soft delete** — `deletedAt` on mutable records; deliberately absent from
  `AuditLog` and `PaymentTransaction`, which must not be editable or hideable.
- **Money** — integer minor units everywhere. Never floats.
- **Idempotency** — enforced by unique constraints, not by check-then-insert,
  which two concurrent requests can both pass.
- **Policy in code, not data** — plan limits, the event catalogue, and the
  taxonomy live in source so they are reviewable and revertible.
- **Motion is feedback, not decoration** — five keyframes total
  (`tailwind.config.ts`), entrances at 180–220ms with travel of 6px or less.
  Entrances say a page changed; `animate-shake` says a submission was rejected;
  `.press` says a tap registered. Every one of them is removed rather than
  shortened under `prefers-reduced-motion` (WCAG 2.1 AA 2.3.3).

---

## Testing

```bash
npm run test                       # everything
cd apps/api && npx jest --coverage
```

899 tests across 44 suites. They are unit and integration tests over real
behaviour — the payment webhook suites drive a real Nest app over HTTP with an
in-memory Prisma that reproduces the actual unique constraints, so retry and race
paths are genuinely exercised rather than mocked.

No database or network is required to run them.

---

## Deployment

Images build from the **repository root**, not from the app directory —
workspaces resolve through the root lockfile:

```bash
docker build -f apps/api/Dockerfile -t legaltech-api:latest .
docker build -f apps/web/Dockerfile -t legaltech-web:latest .
```

`.github/workflows/deploy.yml` runs test → build → deploy on pushes to `main`.

```bash
# One-time cluster setup
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -f infra/k8s/cert-manager.yaml
kubectl -n legaltech create secret generic legaltech-secrets --from-env-file=production.env

kubectl apply -f infra/k8s/config.yaml
kubectl apply -f infra/k8s/services.yaml
kubectl apply -f infra/k8s/api-deployment.yaml
kubectl apply -f infra/k8s/web-deployment.yaml
kubectl apply -f infra/k8s/hpa.yaml
kubectl apply -f infra/k8s/ingress.yaml
```

**Never apply `infra/k8s/secrets.example.yaml`** — it is an empty template and
applying it blanks every real secret in the cluster.

### Health and metrics

| Endpoint        | Purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `/health/live`  | Liveness — heap only. **Does not check Postgres or Redis.**       |
| `/health/ready` | Readiness — checks both; returns 503 immediately on SIGTERM       |
| `/metrics`      | Prometheus exposition. Not routed by the Ingress; in-cluster only |

Liveness deliberately ignores dependencies: failing it *restarts* the pod, so a
database failover would otherwise restart every replica at once and turn a
recoverable blip into an outage.

---

## Known gaps

Stated plainly rather than left to be discovered.

**Resolved since the last pass** — kept here briefly rather than deleted
outright, since "this used to be broken" is exactly the kind of thing a
changelog-less README otherwise loses:

- Document creation now persists. `POST /documents` calls
  `generatedDocument.create` inside a transaction (draft interpolation or AI
  generation, tenant-scoped, audited), and the result reaches the approval
  workflow and PDF/DOCX exporters as designed.
- Recurring billing no longer pretends to charge. None of the four gateways
  supports a merchant-initiated debit, so `RenewalService` now creates a
  payable `PaymentOrder` for what's actually owed and emails the company
  owner(s) a payment-due notice (`billing.renewal_payment_due`) instead of
  silently marking the period paid. The subscription sits `PAST_DUE` with a
  grace period until the order is settled through the existing gateway/webhook
  path, which reactivates it exactly like an upgrade does. A zero balance
  (Free, or fully discounted) still renews immediately — there's nothing to
  collect.
- `npm run lint` passes for `@legaltech/api` — `apps/api/.eslintrc.json` now
  exists.
- The login UI exists (`/login`, plus middleware that redirects an
  unauthenticated request there and back afterward). `tests/e2e/fixtures.ts`
  still signs specs in by copying a cookie rather than driving the form — that
  remains a deliberate speed choice for specs whose subject isn't login itself,
  not a gap. `tests/e2e/login.spec.ts` drives the real form.
- **Registration could not actually produce a working account.** This was a
  worse gap than "no UI": `POST /companies` requires `@Roles('OWNER', 'ADMIN')`,
  a role only an *existing* member can hold, and `CompanyService.create()`
  never wrote the `CompanyMember` row even for a caller who somehow had one.
  No registration path — password or OneID — could ever make a new user the
  owner of anything; only the seed script produced a usable account.
  `POST /auth/company` (no role requirement — there's nothing to require a
  role of yet) now creates the `Company` and its owning `CompanyMember`
  together and reissues the session. `/register` → `/onboarding` covers the
  password path; a first-time OneID login goes straight to `/onboarding` with
  the company's registry details (STIR, name) prefilled from OneID's
  `legalEntities` — held in Redis for one read, never auto-applied without the
  user confirming. The OneID *callback* itself was also fixed: it used to
  return raw JSON instead of ever redirecting the browser back into the web
  app, so `ONEID_REDIRECT_URI` landed nowhere usable regardless. The public
  landing page moved to `/`, and the app itself is now at `/dashboard`.
- Scanned PDFs are OCR'd. Image-only pages are rasterised via `pdftoppm`
  (`PdfRasterizer`) one page at a time and recognised through the existing
  Tesseract pipeline; a page-count ceiling (`OCR_MAX_PDF_PAGES`, default 40)
  refuses absurdly large scans with an actionable message instead of tying up
  the OCR queue for an hour.

- **The dashboard rendered invented numbers.** The first screen after signing
  in showed "24 open matters, 61 documents in review, 7 pending AI analyses"
  and three made-up document names, none of which came from anywhere — "open
  matters" doubly so, since there is no Matter model in the schema. It now
  counts real documents from `/documents` and surfaces a quota warning from
  `/billing/usage`.
- **OCR had no way in.** `POST /search/documents` and the whole Tesseract
  pipeline were built and tested, but there was no file input anywhere in the
  app — the feature was advertised on the landing page and unreachable in the
  product. `/scans` now uploads and lists them.
- **Plans could not be changed from the UI**; the billing page said so
  outright. `/billing` now renders the catalogue with a confirmation dialog
  that distinguishes an immediate upgrade from a deferred downgrade.
- **Dark mode was dead CSS.** `darkMode: ['class']` and a full `.dark` token
  block existed; nothing ever applied the class. There is now a header toggle
  plus a blocking `ThemeScript` so a dark-mode user does not get a white flash
  on every navigation.
- **The notifications bell was decoration** — it rendered with no `onClick`
  and no `href` over a fully built notification backend. It now opens the
  inbox and marks read.
- **No loading, error, or 404 states existed** (`loading.tsx`, `error.tsx`,
  `not-found.tsx`: zero of each). Every route blocked on `await` with the
  previous page frozen on screen. All three now exist, with skeletons.
- **The design system was 6 primitives**, with the input styling copy-pasted
  as a string into four separate form files. Added `Input`/`Textarea`/`Select`,
  `Field` (label + inline per-field error + `aria-describedby` wiring),
  `Card`, `Table`, `Dialog`, `Alert`, `Skeleton`, and a `Toast` provider.
- **434 lines of orphaned editor code** (`components/editor/`) imported only
  by each other and reachable from no route — deleted.

- **Team management now exists end to end.** Inviting a colleague was the one
  gap with no backend at all — `CompanyMember` rows were written only by the
  seed and by onboarding, so a workspace could never gain a second person, and
  an approval chain needs two by definition. `CompanyInvitation` (single-use,
  hash-stored token, partial unique index on the live row) plus `/team` and a
  public `/invitations/:token` accept page close it.
- **Templates can be authored from the UI.** The CRUD, versioning, publish, and
  rollback endpoints were complete and had no caller; `/templates/new` derives
  the variable schema from the `{{placeholders}}` in the body, so the publish
  check that rejects an undeclared placeholder cannot fail by accident.
- **The admin revenue figures are charted** — a sequential ramp for MRR by plan
  and a diverging bar for MRR movement. Both palettes were run through a
  contrast/CVD validator against this app's own surfaces rather than picked by
  eye; green/red was rejected for the movement chart despite being the finance
  convention, because it is the worst pair for a red-green colour blind reader.
- **The browser suite runs green for the first time (30/30).** Getting there
  surfaced two real defects, not just flaky assertions: text typed before React
  hydrated was silently discarded on submit (controlled inputs re-rendering from
  empty state), and the three PDF-export tests — the only check that Cyrillic
  survives into a generated PDF — had been skipping since they were written,
  under a reason that stopped being true months ago.

**Still open, non-blocking:**

- **The corpus has no automated source yet.** `LegalCorpusSource` and the whole
  pipeline behind it — article splitting, embedding, hybrid retrieval, citation
  — are built and tested, but the only implementation reads a directory of
  files. lex.uz is the sole official publisher of Uzbek legislation, documents
  no API, publishes no terms of use at a stable URL, and is operated by a state
  institution, so this repository does not ship a scraper for it. The route in
  is a bulk export or data-sharing agreement with the "Adolat" centre under the
  Ministry of Justice; a lex.uz adapter is then one class and nothing above it
  changes. Until the corpus is populated, AI answers remain ungrounded — which
  is the single largest functional gap against competing products in this
  market.
- **iHamkor's wire contract is assumed.** Their API documentation sits behind
  bot protection and credentials are issued per client, so the request path,
  the JSON field names in `IHamkorProvider.parse`, and the status codes are
  inferred rather than confirmed. The whole payload is read in that one method,
  which fails loudly on a shape it does not recognise instead of returning a
  half-filled entity — a counterparty silently missing its director would reach
  a signature page looking complete. Verified end to end against a stub; the
  only thing outstanding is the real field names.
- **OneID's wire contract has not been reconciled against the operator's docs.**
  `OneIdService` implements the flow as an OAuth2 authorization-code exchange
  with a Redis-held single-use `state`, which is structurally right, but
  id.egov.uz is vendor-specific rather than standards-compliant and the exact
  parameter names, the `legalEntities` payload shape, and the token endpoint's
  response envelope are assumed. Same class of gap as Uzum below, and it needs
  the issued client credentials to verify against — the flow cannot be
  exercised end to end without them.
- **Uzum's wire contract is assumed.** Click and Payme follow published merchant
  protocols. Uzum issues its contract per merchant; the field names and signature
  base string in `UzumService` must be reconciled against the issued agreement
  before go-live. The signing logic is isolated in one method for that reason.
  Not something fixable from inside this repository — it needs the issued
  agreement.
- **The Tesseract cache PVC needs `ReadWriteMany`**, which most managed
  Kubernetes block storage does not provide. Alternatives are documented in
  `infra/k8s/config.yaml`.
- **MRR movement is approximate.** It reconstructs the prior month from
  successful charges rather than a stored snapshot, so a mid-month signup appears
  at its charged amount rather than prorated. A nightly MRR snapshot table would
  make it exact.
- **Most of the notification catalogue is never dispatched.** `NotificationService`
  is fully built, `@Global()`, and wired for the renewal-payment-due path — but
  approval requests, OCR completion, and security alerts are all still
  cataloged in `notification-events.ts` without a single call site. The module
  works; most of the app does not call it yet. The inbox UI reads whatever
  *is* dispatched, so this shows up as a mostly-empty bell rather than a broken one.
- **Both automated suites now run green against real infrastructure**: the API
  e2e suite (47 cases, real Postgres, real migrations) and Playwright (36 cases
  per browser, a real browser). `test-e2e-browser` is still `continue-on-error`
  in CI until it has had a few green runs on a machine that is not this one.
  The Playwright config declares a Firefox project as well as Chromium; a
  machine that has only ever run `npx playwright install chromium` fails all 36
  Firefox cases on a missing executable, which looks like 26 unrelated
  application faults. `npx playwright install` (no argument) fetches both.

---

## Repository layout

```
apps/
  api/            NestJS — src/modules/<feature>/
  web/            Next.js — app/, components/, lib/
packages/
  database/       Prisma schema, migrations, generated client
infra/
  k8s/            Kubernetes manifests
  nginx/          nginx configuration
.github/workflows/
  deploy.yml      test → build → deploy
```
