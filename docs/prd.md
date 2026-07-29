# Product Requirements Document: AI LegalTech SaaS Platform

- **Status:** Draft
- **Version:** 0.1
- **Last updated:** 2026-07-29
- **Owner:** TBD

## 1. Overview

An AI-powered SaaS platform for law firms and in-house legal teams to manage
matters (cases), ingest and analyze legal documents with AI, and collaborate
across attorneys, paralegals, and clients. The platform combines a case/matter
management system with an AI layer that summarizes documents, extracts key
clauses/dates/obligations, and flags risk.

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

| Persona | Needs |
|---|---|
| **Attorney** | View/manage assigned matters, review AI-generated document summaries, track deadlines. |
| **Paralegal** | Upload and organize documents, monitor matter status, prep summaries for attorney review. |
| **Firm Admin** | Manage organization, users, roles, and access across all matters. |
| **Client** (future phase) | View shared documents and matter status via a limited client portal. |

## 5. Core Features (MVP)

1. **Authentication & Organizations**
   - Email/password (or SSO, TBD) auth scoped to a law firm ("Organization").
   - Role-based access control: `ADMIN`, `ATTORNEY`, `PARALEGAL`, `CLIENT`.
2. **Matter Management**
   - Create/update/close matters with client name, status, and assignees.
   - Matter statuses: `OPEN`, `IN_REVIEW`, `CLOSED`, `ARCHIVED`.
3. **Document Management**
   - Upload documents to a matter (stored in object storage, e.g. S3-compatible).
   - Track processing lifecycle: `UPLOADED` → `PROCESSING` → `ANALYZED` / `FAILED`.
4. **AI Document Analysis**
   - Automatic summarization of uploaded documents (`aiSummary` field).
   - Future: clause extraction, key-date extraction, risk flagging.
5. **Dashboard**
   - Overview of open matters, recent documents, and pending AI analyses.

## 6. Tech Stack

- **Monorepo tooling:** Turborepo + npm workspaces.
- **Web app (`apps/web`):** Next.js 14 (App Router), React 18, TypeScript.
- **API (`apps/api`):** NestJS 10, TypeScript.
- **Shared database layer (`packages/database`):** Prisma ORM + PostgreSQL,
  published internally as `@legaltech/database` and consumed by both apps.
- **AI provider:** Anthropic Claude (via `ANTHROPIC_API_KEY`).
- **Storage:** S3-compatible object storage for uploaded documents.

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
- `DocumentTemplate` — reusable clause/contract template, body stored as
  TipTap editor JSON, versioned and unique per `(companyId, slug)`.
- `TemplateEmbedding` — chunked template text plus a `pgvector`
  `vector(1024)` embedding for semantic retrieval, indexed with HNSW /
  `vector_cosine_ops`. Derived data: rebuilt rather than soft-deleted.

**Generated output**
- `GeneratedDocument` — an AI-generated document belonging to a `Company`,
  optionally derived from a `DocumentTemplate`, retaining its
  `promptVariables` for reproducibility.

**Billing**
- `Subscription` — one per `Company`, with plan/status and billing-provider
  identifiers.
- `PaymentTransaction` — immutable financial ledger in minor units;
  corrections are new rows, never edits.

**Audit**
- `AuditLog` — append-only trail (no `updatedAt`, no `deletedAt`) of actions
  against entities, retained by time-based pruning.

### Soft delete

Mutable, user-facing models carry `deletedAt` and are filtered out of all read
paths: `User`, `Company`, `CompanyMember`, `DocumentTemplate`,
`GeneratedDocument`, `Subscription`. It is deliberately **omitted** from
`AuditLog` and `PaymentTransaction` (records that must not be editable or
hideable to remain audit-worthy), `RefreshToken` (`revokedAt` already models
invalidation), and `TemplateEmbedding` (derived, cascades with its template).

This is expected to evolve (e.g. adding
audit logs, billing entities, client-portal-specific models).

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

1. **M0 — Monorepo scaffold** (this document's companion change): Turborepo
   structure, Next.js web shell, NestJS API shell, shared Prisma package.
2. **M1 — Auth & Companies:** login with refresh-token rotation, company
   creation, role-based access via `CompanyMember`.
3. **M2 — Template & Document CRUD:** end-to-end template and generated-document
   management UI and API.
4. **M3 — AI Analysis Pipeline:** async document summarization via Claude,
   status updates surfaced in the UI.
5. **M4 — Client Portal (beta):** read-only client access to shared matters
   and documents.

## 10. Success Metrics

- Time from document upload to available AI summary.
- % of matters actively used (created + updated) by pilot firms weekly.
- Reduction in reported manual document-review time (via pilot user surveys).

## 11. Open Questions

- SSO requirement for launch, or email/password sufficient for MVP?
- Which AI outputs are must-have for MVP beyond summarization (clause
  extraction, deadline extraction)?
- Data residency requirements for target initial customers.
