-- ---------------------------------------------------------------------------
-- Editable documents, with history.
--
-- A generated document was previously immutable: created, approved, exported.
-- Real drafting is not that — a clause gets reworded, a date corrected, an
-- annex added — and without an edit path every correction meant regenerating
-- from the template and losing the work.
--
-- Editing a document that others have approved would silently invalidate their
-- approval, so the service refuses it; see DocumentEditService. This migration
-- only provides somewhere to keep what the document said before each change.
-- ---------------------------------------------------------------------------

ALTER TABLE "generated_documents"
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "generated_document_versions" (
    "id"            TEXT NOT NULL,
    "documentId"    TEXT NOT NULL,
    "version"       INTEGER NOT NULL,
    "title"         TEXT NOT NULL,
    "content"       JSONB,
    "editedById"    TEXT,
    "approvalRound" INTEGER NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_document_versions_pkey" PRIMARY KEY ("id")
);

-- The uniqueness that makes concurrent saves safe. Two people saving at once
-- both read revision 3 and both try to write version 3; this turns the second
-- into a constraint violation the service retries, rather than two rows
-- claiming to be the same point in the document's history.
CREATE UNIQUE INDEX "generated_document_versions_documentId_version_key"
    ON "generated_document_versions"("documentId", "version");

CREATE INDEX "generated_document_versions_documentId_createdAt_idx"
    ON "generated_document_versions"("documentId", "createdAt");

ALTER TABLE "generated_document_versions"
    ADD CONSTRAINT "generated_document_versions_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "generated_documents"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL rather than CASCADE: a departing employee's account being removed
-- must not delete the record of what a contract said while they worked on it.
ALTER TABLE "generated_document_versions"
    ADD CONSTRAINT "generated_document_versions_editedById_fkey"
    FOREIGN KEY ("editedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
