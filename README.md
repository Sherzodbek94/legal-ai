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

npm install                 # installs every workspace
cp .env.example .env        # then edit it — see below

npm run db:generate         # generate the Prisma client
npm run db:migrate          # apply migrations
npm run dev                 # api on :4000, web on :3000
```

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

| Command               | What it does                                    |
| --------------------- | ----------------------------------------------- |
| `npm run dev`         | API and web in watch mode                       |
| `npm run build`       | Build every workspace                           |
| `npm run test`        | Full test suite                                 |
| `npm run lint`        | Lint (see *Known gaps*)                         |
| `npm run db:generate` | Regenerate the Prisma client                    |
| `npm run db:migrate`  | Create and apply a migration (development)      |
| `npm run db:studio`   | Prisma Studio                                   |
| `npm run clean`       | Remove build output and `node_modules`          |

Run a single test file:

```bash
cd apps/api && npx jest src/modules/billing/limits/quota-policy.spec.ts
npx jest -t "does not double-bill"        # by test name
```

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
| `template`    | 288-leaf taxonomy, immutable versions, multi-role approval chains     |
| `ai-engine`   | Claude primary with OpenAI failover, strict JSON-schema output        |
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

---

## Testing

```bash
npm run test                       # everything
cd apps/api && npx jest --coverage
```

786 tests across 33 suites. They are unit and integration tests over real
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

Stated plainly rather than left to be discovered:

- **`npm run lint` fails for `@legaltech/api`.** There is no ESLint config in
  `apps/api` and there never has been; the script errors before linting anything.
  `@legaltech/web` lints clean.
- **Scanned PDFs are not OCR'd.** PDFs with a text layer extract correctly.
  Image-only PDFs need rasterisation via `pdftoppm`; the API image installs
  `poppler-utils`, but the extractor does not yet shell out to it and fails with
  an explicit message instead of indexing a blank document.
- **Recurring billing does not charge.** `RenewalService.attemptCharge` is a stub
  that always succeeds. None of the four gateways supports merchant-initiated
  recurring debits the way Stripe subscriptions do, so this needs a product
  decision — most likely emailing a payment link each period.
- **Uzum's wire contract is assumed.** Click and Payme follow published merchant
  protocols. Uzum issues its contract per merchant; the field names and signature
  base string in `UzumService` must be reconciled against the issued agreement
  before go-live. The signing logic is isolated in one method for that reason.
- **The Tesseract cache PVC needs `ReadWriteMany`**, which most managed
  Kubernetes block storage does not provide. Alternatives are documented in
  `infra/k8s/config.yaml`.
- **MRR movement is approximate.** It reconstructs the prior month from
  successful charges rather than a stored snapshot, so a mid-month signup appears
  at its charged amount rather than prorated. A nightly MRR snapshot table would
  make it exact.
- **No E2E or load tests yet.** Unit and integration coverage is good; Playwright
  and k6 are not written.

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
