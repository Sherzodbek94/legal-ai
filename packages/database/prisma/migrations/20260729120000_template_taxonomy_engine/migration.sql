-- ---------------------------------------------------------------------------
-- Template Taxonomy Engine
--
-- Adds the category tree, immutable template versions, and the multi-role
-- document approval chain.
--
-- `ALTER TYPE ... ADD VALUE` runs inside the migration transaction, which
-- requires PostgreSQL >= 12. The extended enum values are not referenced by any
-- statement in this same migration, so the new labels do not need to be visible
-- before it commits.
-- ---------------------------------------------------------------------------

-- AlterEnum
ALTER TYPE "GeneratedDocumentStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "GeneratedDocumentStatus" ADD VALUE 'REJECTED';
ALTER TYPE "GeneratedDocumentStatus" ADD VALUE 'COMPLETED';

-- CreateEnum
CREATE TYPE "TemplateCategoryKind" AS ENUM ('CONTRACT', 'HR_ORDER', 'CORPORATE_ACT');

-- CreateEnum
CREATE TYPE "ApprovalStepStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED');

-- CreateTable
CREATE TABLE "template_categories" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "parentId" TEXT,
    "kind" "TemplateCategoryKind" NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameRu" TEXT,
    "nameUz" TEXT,
    "description" TEXT,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "template_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "variableSchema" JSONB NOT NULL,
    "approvalChain" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_approvals" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "stepOrder" INTEGER NOT NULL,
    "requiredRole" "CompanyMemberRole" NOT NULL,
    "label" TEXT,
    "status" "ApprovalStepStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_approvals_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "document_templates" ADD COLUMN "categoryId" TEXT,
                                 ADD COLUMN "currentVersionId" TEXT;

-- AlterTable
ALTER TABLE "generated_documents" ADD COLUMN "templateVersionId" TEXT,
                                  ADD COLUMN "approvalRound" INTEGER NOT NULL DEFAULT 0,
                                  ADD COLUMN "submittedAt" TIMESTAMP(3),
                                  ADD COLUMN "submittedById" TEXT,
                                  ADD COLUMN "completedAt" TIMESTAMP(3),
                                  ADD COLUMN "rejectionReason" TEXT;

-- CreateIndex
CREATE INDEX "template_categories_kind_depth_sortOrder_idx" ON "template_categories"("kind", "depth", "sortOrder");

-- CreateIndex
CREATE INDEX "template_categories_companyId_kind_deletedAt_idx" ON "template_categories"("companyId", "kind", "deletedAt");

-- CreateIndex
CREATE INDEX "template_categories_parentId_sortOrder_idx" ON "template_categories"("parentId", "sortOrder");

-- CreateIndex
CREATE INDEX "template_categories_path_idx" ON "template_categories"("path");

-- CreateIndex
CREATE UNIQUE INDEX "template_categories_companyId_path_key" ON "template_categories"("companyId", "path");

-- CreateIndex
CREATE INDEX "template_versions_templateId_status_idx" ON "template_versions"("templateId", "status");

-- CreateIndex
CREATE INDEX "template_versions_templateId_version_idx" ON "template_versions"("templateId", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_templateId_version_key" ON "template_versions"("templateId", "version");

-- CreateIndex
CREATE INDEX "document_approvals_documentId_status_idx" ON "document_approvals"("documentId", "status");

-- CreateIndex
CREATE INDEX "document_approvals_decidedById_decidedAt_idx" ON "document_approvals"("decidedById", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "document_approvals_documentId_round_stepOrder_key" ON "document_approvals"("documentId", "round", "stepOrder");

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_currentVersionId_key" ON "document_templates"("currentVersionId");

-- CreateIndex
CREATE INDEX "document_templates_categoryId_status_deletedAt_idx" ON "document_templates"("categoryId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "generated_documents_templateVersionId_idx" ON "generated_documents"("templateVersionId");

-- AddForeignKey
ALTER TABLE "template_categories" ADD CONSTRAINT "template_categories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_categories" ADD CONSTRAINT "template_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "template_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "document_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "template_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_approvals" ADD CONSTRAINT "document_approvals_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "generated_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_approvals" ADD CONSTRAINT "document_approvals_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Uniqueness for the platform-wide taxonomy.
--
-- `template_categories_companyId_path_key` above cannot police the shared
-- catalogue: PostgreSQL treats NULLs as distinct, so every global row (where
-- "companyId" IS NULL) trivially satisfies it and the seed could insert the
-- same path twice. Prisma's schema language cannot express a partial index, so
-- this is appended by hand and must be carried forward on any regeneration of
-- this migration.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "template_categories_global_path_key"
    ON "template_categories"("path")
    WHERE "companyId" IS NULL;
