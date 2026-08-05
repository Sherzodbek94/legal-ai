# Product Requirements Document: AI LegalTech SaaS Platform

- **Status:** Reconciled against the implementation
- **Version:** 0.2
- **Last updated:** 2026-08-05
- **Owner:** TBD

> **Note on this revision.** Version 0.1 described a matter-management product
> for a generic market. What was built is a document-*generation* product for
> Uzbekistan, and the two had drifted far enough apart that the document
> described features with no code and no schema behind them — there is no
> `Matter` model and never was. Sections 1 and 4–7 and 9 were rewritten against
> the schema and the modules as they stand on 2026-08-05. Sections 2, 3 and 8
> still read true and are unchanged. Anything describing intent rather than
> code is marked **TBD** rather than guessed at.

## 1. Overview

An AI-powered SaaS platform for law firms and in-house legal teams in
**Uzbekistan** to draft, review, and approve legal documents. A company keeps
its own versioned template library; the AI drafts from a template and the
variables supplied, grounded in the legislation corpus, and the result moves
through an approval chain before it is finalised.

Around that sit the things the market requires rather than the product: Uzbek
and Russian document handling, OneID as an identity provider, local payment
gateways, counterparty lookup from the state business register, and OCR over
scans in Latin and Cyrillic.

## 2. Problem Statement

Legal teams spend a disproportionate amount of billable time on manual
document review, matter status tracking, and client communication spread
across email, shared drives, and disconnected practice-management tools. Small
and mid-sized firms in particular lack affordable tooling that combines matter
management with modern AI document analysis.

## 3. Goals

- Provide a single system of record for matters, clients, and documents.
- Use AI to reduce the time spent on first-pass document review and
  summarization.
- Give attorneys and paralegals a fast way to track matter status and
  assignments.
- Lay a foundation that is extensible toward billing, e-signature, and
  client-portal features in later phases.

### Non-goals (out of scope for MVP)

- Billing / time tracking / invoicing.
- E-signature workflows.
- Court e-filing integrations.
- Native mobile apps.

## 4. Target Users

Roles are `CompanyMemberRole` on the tenant membership, not on the account —
one person can hold different roles in different companies.

| Role | Needs |
|---|---|
| **`OWNER`** | Billing, plan limits, the template library, and who is in the company. One per company; cannot be removed. |
| **`ADMIN`** | Everything the owner does except billing. Invites and removes members. |
| **`ATTORNEY`** | Drafts documents from templates, edits generated bodies, approves what is submitted to them. |
| **`PARALEGAL`** | Drafts and uploads, submits into the approval chain, cannot approve. |
| **`VIEWER`** | Read-only across the company's documents. |
| **`SUPER_ADMIN`** | Platform operator, not a company member: cross-tenant admin, audited impersonation, AI cost and revenue reporting. |

A client-facing portal is **not built** and has no models behind it.

## 5. Core Features

Everything below is implemented. Module names are `apps/api/src/modules/*`.

1. **Authentication & companies** (`auth`, `company`)
   - Four ways in, all binding to the provider's stable subject rather than an
     email address: password, OneID, Google, and phone + SMS code. A correct
     SMS code *is* the sign-in — the number is unique and proven by
     possession — and a first code to an unknown number creates the account.
   - Refresh-token rotation; tokens stored hashed with a hard expiry sweep.
   - Companies with token-based email invitations and per-company roles.
2. **Templates** (`template`)
   - Versioned per company, body stored as TipTap JSON, unique per
     `(companyId, slug)`. Each version declares a variable schema the
     generation form is built from and the API re-validates against.
   - Semantic retrieval over chunked template text (`pgvector`, HNSW).
3. **Document generation and editing** (`document`, `ai-engine`)
   - Drafting from a template plus variables, with the plain interpolated
     template as the fallback when a provider is down.
   - Version history on every generated document.
   - Export to PDF (Puppeteer) and native DOCX, each carrying an HMAC-signed
     QR verification code that resolves for people who are not users.
4. **Approval chain** (`document`)
   - `DRAFT` → `GENERATING` → `GENERATED` → `PENDING_APPROVAL` →
     `COMPLETED` / `REJECTED`, plus `FINALIZED` and `FAILED`. A rejection
     returns the document to `DRAFT` for correction and resubmission.
5. **Legislation corpus and chat** (`legal-corpus`, `chat`)
   - The statute book indexed once and shared by every tenant, cited by
     article rather than quoted.
   - Chat answers grounded in it, with article-level citations attached.
6. **OCR and search** (`ocr-search`)
   - Tesseract over Uzbek Latin, Uzbek Cyrillic and Russian; PDFs with a text
     layer are extracted directly and pure scans rasterised first.
   - Hybrid search: vector similarity combined with Postgres full-text.
7. **Counterparty lookup** (`counterparty`)
   - The other party's registered details pulled from the state business
     register by STIR and mapped onto template variables, so a drafter is not
     retyping from a scan and the AI is not asked to invent a number.
8. **Billing and payments** (`billing`, `payment`)
   - `FREE` / `PRO` / `BUSINESS` / `ENTERPRISE`, quota enforcement, coupons,
     and hourly renewal passes with a grace period before a failed card cuts
     service.
   - CLICK, Payme, Uzum and Stripe behind idempotent webhooks.
9. **Notifications** (`notification`)
   - One BullMQ queue per channel — SMS, Telegram, email, in-app WebSocket —
     because the channels fail differently and a stalled one must not hold up
     the others.
10. **Admin** (`admin`, `health`)
    - MRR/ARR, per-provider AI cost tracking, account locking, audited
      impersonation, Prometheus metrics and liveness/readiness probes.

### Confidentiality

Identifiers in template values — STIR, settlement accounts, passport numbers,
phones — are replaced with placeholders before any prompt leaves the process
and restored into the answer. On unless `AI_REDACT_PII` is exactly `false`.

## 6. Tech Stack

- **Monorepo tooling:** Turborepo + npm workspaces.
- **Web app (`apps/web`):** Next.js 14 (App Router), React 18, TypeScript.
- **API (`apps/api`):** NestJS 11, TypeScript. Socket.IO gateway for in-app
  notifications, BullMQ workers for everything asynchronous.
- **Shared database layer (`packages/database`):** Prisma ORM + PostgreSQL 16,
  published internally as `@legaltech/database` and consumed by both apps.
  **`pgvector` is required**, not optional — the schema declares `vector(1536)`
  columns and the first migration fails without it.
- **Redis 7:** sessions, OTP challenges, OneID CSRF state, BullMQ queues, and
  the Socket.IO adapter. Not optional: without it nobody can sign in.
- **AI providers:** Anthropic Claude primary, OpenAI as failover; which one
  leads is `AI_PRIMARY_PROVIDER`. A provider with no key configured is skipped
  rather than attempted. OpenAI also supplies embeddings, which must produce
  1536 dimensions to match the schema.
- **SMS:** DevSMS.uz. Sign-in codes go through its pre-approved `universal_otp`
  templates, because operators here only carry moderated message text.
- **Storage:** S3-compatible object storage. The bucket must be private —
  seals and signatures are forgery-grade material and are served only through
  short-lived presigned URLs.
- **Deployment:** Kubernetes; images built and pushed by CI from `master`.

## 7. Data Model

Defined in `packages/database/prisma/schema.prisma`:

**Identity**
- `User` — platform account (`UserRole`: `SUPER_ADMIN` / `USER`). Tenant
  permissions live on `CompanyMember`, not here.
- `RefreshToken` — hashed rotating session tokens, with `revokedAt` and a hard
  `expiresAt` sweep.

**Tenancy**
- `Company` — a law firm / tenant; the root of every tenant-scoped query.
- `CompanyMember` — join of `User` × `Company` carrying a
  `CompanyMemberRole` (`OWNER`, `ADMIN`, `ATTORNEY`, `PARALEGAL`, `VIEWER`),
  unique per pair.

**Templates and retrieval**
- `DocumentTemplate` / `TemplateVersion` — reusable clause/contract template,
  body stored as TipTap editor JSON, versioned and unique per
  `(companyId, slug)`. `TemplateCategory` groups them.
- `TemplateEmbedding` — chunked template text plus a `pgvector`
  `vector(1536)` embedding for semantic retrieval, indexed with HNSW /
  `vector_cosine_ops`. Derived data: rebuilt rather than soft-deleted.

**Generated output**
- `GeneratedDocument` — an AI-generated document belonging to a `Company`,
  optionally derived from a `DocumentTemplate`, retaining its
  `promptVariables` for reproducibility.
- `GeneratedDocumentVersion` — body snapshots, so an edit is recoverable.
- `DocumentApproval` — one row per step of the approval chain.

**Scans and legislation**
- `ScannedDocument` / `DocumentChunk` — uploaded scans, their OCR status, and
  the chunked text plus embedding each tenant's search runs over.
- `LegalAct` / `LegalActChunk` — the statute book, shared by every tenant and
  cited by article.
- `ChatConversation` / `ChatMessage` — grounded legal chat and its citations.

**Billing**
- `Subscription` — one per `Company`, with plan/status and billing-provider
  identifiers.
- `PaymentTransaction` — immutable financial ledger in minor units;
  corrections are new rows, never edits.
- `PaymentOrder` / `ProviderTransaction` / `IdempotencyRecord` — a checkout and
  the gateway transaction pointing at it, plus the record that makes a repeated
  webhook a no-op instead of a double charge.
- `UsageCounter`, `Coupon`, `CouponRedemption` — quota enforcement and discounts.

**Audit**
- `AuditLog` — append-only trail (no `updatedAt`, no `deletedAt`) of actions
  against entities, retained by time-based pruning.
- `ImpersonationSession` — every operator impersonation, opened and closed.

### Soft delete

Mutable, user-facing models carry `deletedAt` and are filtered out of all read
paths: `User`, `Company`, `CompanyMember`, `DocumentTemplate`,
`GeneratedDocument`, `Subscription`. It is deliberately **omitted** from
`AuditLog` and `PaymentTransaction` (records that must not be editable or
hideable to remain audit-worthy), `RefreshToken` (`revokedAt` already models
invalidation), and `TemplateEmbedding` (derived, cascades with its template).

Audit and billing entities, listed above, have since been added; the
client-portal models have not.

## 8. Non-Functional Requirements

- **Security & confidentiality:** Legal documents are highly sensitive.
  Enforce org-scoped data isolation (tenant isolation) at the API/query layer,
  encrypt data at rest and in transit, and avoid logging document contents.
- **Auditability:** All matter and document mutations should eventually be
  traceable to a user and timestamp (audit log — post-MVP).
- **Compliance:** Design with future SOC 2 / GDPR-style requirements in mind
  (data residency, right-to-delete, access logging), even if not fully
  implemented in MVP.
- **Availability:** Target standard SaaS uptime (99.9%) once out of MVP.
- **Performance:** AI document analysis should run asynchronously and never
  block the upload request/response cycle.

## 9. Milestones / Roadmap

### Delivered

Built between 2026-07 and 2026-08-05 and committed as "phase 01–18". Grouped
here by what shipped, since the phase numbers exist only in commit messages:

| Area | State |
|---|---|
| Monorepo, Prisma package, CI/CD, Kubernetes manifests | Done |
| Auth: password, OneID, Google, phone + SMS; refresh rotation | Done |
| Companies, invitations, per-company roles | Done |
| Template library, versions, variable schemas, semantic retrieval | Done |
| AI drafting, editing, version history, approval chain | Done |
| PDF / DOCX export with QR verification | Done |
| OCR (uz-Latn, uz-Cyrl, ru) and hybrid search | Done |
| Legislation corpus and cited legal chat | Done |
| Counterparty lookup by STIR | Done |
| Billing, quotas, coupons, renewals | Done |
| CLICK, Payme, Uzum, Stripe | Integrated; **Uzum's signature base string is
  still to be reconciled against the per-merchant contract before go-live** |
| Notifications: SMS, Telegram, email, in-app | Done |
| Admin: revenue, AI costs, locking, audited impersonation | Done |
| Observability: Prometheus, probes, graceful shutdown | Done |

### Before launch

These are known and blocking, in the order they bite:

1. **Alfa Nom (branded SMS sender).** Operator approval takes 1–2 months.
   Nothing in the code waits on it — codes go out under DevSMS's own approved
   sender meanwhile — but the calendar does.
2. **Uzum contract reconciliation.** See the table above.
3. **Legislation corpus content.** `LEGAL_CORPUS_DIR` is empty; the retrieval
   half of "answers grounded in Uzbek law" has nothing to retrieve until text
   is lawfully obtained and pointed at. No scraper ships for lex.uz, and
   deliberately so — see the note in `.env.example`.
4. **Data residency.** Open question 3 below; it constrains hosting and cannot
   be deferred past the first enterprise conversation.

### Not built, and not scheduled

- **Client portal.** No models, no routes. Still the obvious next surface, but
  it needs a product decision before an engineering one. **TBD.**
- Time tracking, invoicing, e-signature, court e-filing, native mobile — all
  still non-goals (section 3).

## 10. Success Metrics

- Time from document upload to available AI summary.
- % of matters actively used (created + updated) by pilot firms weekly.
- Reduction in reported manual document-review time (via pilot user surveys).

## 11. Open Questions

1. ~~SSO requirement for launch, or email/password sufficient for MVP?~~
   **Settled by building all four.** Password, OneID, Google and phone + SMS
   are live; each federated method binds the provider's stable subject rather
   than the email address.
2. ~~Which AI outputs are must-have for MVP beyond summarization?~~
   **Settled: generation, not summarization.** The product drafts from
   templates, edits bodies, and answers questions against the legislation
   corpus with article citations. Clause extraction and deadline extraction
   were never built and are not scheduled.
3. **Data residency requirements for target initial customers — still open,
   and now blocking.** The stack can be self-hosted end to end (SMTP instead
   of Resend, MinIO instead of managed S3), but the AI providers are not in
   country and every draft leaves the jurisdiction. PII redaction narrows what
   leaves; it does not change where the text goes. This constrains hosting and
   needs an answer before the first enterprise conversation. **TBD.**
4. **Who owns this document?** Header still says TBD. Version 0.1 drifted for
   about five weeks before anyone reconciled it. **TBD.**
