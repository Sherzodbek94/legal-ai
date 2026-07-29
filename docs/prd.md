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

## 7. Data Model (initial)

Defined in `packages/database/prisma/schema.prisma`:

- `Organization` — a law firm / tenant.
- `User` — belongs to an `Organization`, has a `UserRole`, can be assigned to
  multiple `Matter`s.
- `Matter` — belongs to an `Organization`, has a `MatterStatus`, has many
  `Document`s and assignees.
- `Document` — belongs to a `Matter`, has a `DocumentStatus` and an optional
  AI-generated `aiSummary`.

This is intentionally minimal for MVP and expected to evolve (e.g. adding
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
2. **M1 — Auth & Organizations:** login, org creation, role-based access.
3. **M2 — Matter & Document CRUD:** end-to-end matter/document management UI
   and API.
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
