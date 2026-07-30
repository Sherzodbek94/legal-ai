-- ---------------------------------------------------------------------------
-- OCR and hybrid search
--
-- Adds the scanned-document corpus, its searchable chunks, and both retrieval
-- indexes: HNSW over the embedding for cosine similarity, GIN over a generated
-- tsvector for lexical matching.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'LOW_CONFIDENCE', 'FAILED');

-- ---------------------------------------------------------------------------
-- Widen template embeddings from 1024 to 1536.
--
-- DESTRUCTIVE. A pgvector column's dimension is part of its type, so there is no
-- in-place widening and no way to preserve the old vectors — a 1024-dim
-- voyage-law-2 embedding is not a truncated 1536-dim OpenAI one, it is a point in
-- a different space. The column is dropped and recreated empty, and every
-- template must be re-embedded afterwards.
--
-- The reason for doing it at all: templates and scanned documents are searched
-- by the same queries, and vectors from different models cannot be compared.
-- Keeping two embedding spaces would mean two indexes, two backfill jobs, and a
-- standing trap where a cross-space comparison returns plausible nonsense
-- instead of an error.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "template_embeddings_embedding_hnsw_idx";
ALTER TABLE "template_embeddings" DROP COLUMN IF EXISTS "embedding";
ALTER TABLE "template_embeddings" ADD COLUMN "embedding" vector(1536);
ALTER TABLE "template_embeddings" ALTER COLUMN "embeddingModel" SET DEFAULT 'text-embedding-3-small';

CREATE INDEX "template_embeddings_embedding_hnsw_idx"
    ON "template_embeddings"
    USING hnsw ("embedding" vector_cosine_ops);

-- CreateTable
CREATE TABLE "scanned_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" "OcrStatus" NOT NULL DEFAULT 'PENDING',
    "languages" TEXT[],
    "pageCount" INTEGER,
    "confidence" DOUBLE PRECISION,
    "extractionMethod" TEXT,
    "extractedText" TEXT,
    "failureReason" TEXT,
    "processingMs" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "scanned_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "scannedDocumentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "page" INTEGER,
    "embeddingModel" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scanned_documents_storageKey_key" ON "scanned_documents"("storageKey");

-- CreateIndex
CREATE INDEX "scanned_documents_companyId_status_createdAt_idx" ON "scanned_documents"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "scanned_documents_status_attempts_idx" ON "scanned_documents"("status", "attempts");

-- CreateIndex
CREATE INDEX "scanned_documents_companyId_checksum_idx" ON "scanned_documents"("companyId", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_scannedDocumentId_chunkIndex_key" ON "document_chunks"("scannedDocumentId", "chunkIndex");

-- CreateIndex
CREATE INDEX "document_chunks_companyId_scannedDocumentId_idx" ON "document_chunks"("companyId", "scannedDocumentId");

-- AddForeignKey
ALTER TABLE "scanned_documents" ADD CONSTRAINT "scanned_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_scannedDocumentId_fkey" FOREIGN KEY ("scannedDocumentId") REFERENCES "scanned_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Lexical search vector.
--
-- A GENERATED column rather than a trigger: it cannot drift from `content`, and
-- there is no ordering hazard between the insert and a trigger firing.
--
-- CONFIGURATION CHOICE — 'simple', not 'russian'. This looks like a downgrade and
-- is deliberate:
--
--   * PostgreSQL ships no Uzbek text-search configuration. There is no stemmer
--     and no stopword list, so 'uzbek' is not an option that exists.
--   * Uzbek legal documents routinely mix Uzbek and Russian inside one
--     paragraph — a contract with Russian bank details and Uzbek clause text is
--     ordinary, not unusual. Any single stemmer is therefore wrong for part of
--     nearly every document: the Russian stemmer applied to Uzbek text produces
--     confident nonsense stems that match the wrong words.
--   * A generated column needs an IMMUTABLE expression, and choosing the
--     configuration per row (`to_tsvector(lang::regconfig, content)`) is not —
--     the text-to-regconfig cast is only STABLE. So per-row configuration is
--     unavailable regardless.
--
-- 'simple' lowercases and splits on non-word characters without stemming, which
-- gives exact-token matching that is correct (if strict) for both languages. The
-- morphological tolerance a stemmer would have provided is supplied instead by
-- the semantic half of the hybrid query — which is a large part of why this
-- corpus needs hybrid search rather than either method alone.
-- ---------------------------------------------------------------------------
ALTER TABLE "document_chunks"
    ADD COLUMN "searchVector" tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce("content", ''))) STORED;

CREATE INDEX "document_chunks_search_vector_gin_idx"
    ON "document_chunks"
    USING gin ("searchVector");

-- ---------------------------------------------------------------------------
-- Approximate-nearest-neighbour index for semantic retrieval.
--
-- HNSW over `vector_cosine_ops`, pairing with the `<=>` cosine-distance operator.
-- OpenAI returns unit-normalised embeddings, so cosine distance and inner
-- product rank identically here; cosine is used because it is the operator the
-- queries are written against and it stays correct if a future model is not
-- normalised.
--
-- HNSW rather than IVFFlat: it needs no training pass over existing rows, so it
-- is correct on an empty table and as chunks are appended one document at a time.
-- ---------------------------------------------------------------------------
CREATE INDEX "document_chunks_embedding_hnsw_idx"
    ON "document_chunks"
    USING hnsw ("embedding" vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Partial index for the OCR worker's claim query.
--
-- The worker polls for PENDING rows under the retry ceiling. Those are a tiny
-- fraction of the table once documents start completing, so a partial index
-- stays small and the poll stays index-only.
-- ---------------------------------------------------------------------------
CREATE INDEX "scanned_documents_pending_idx"
    ON "scanned_documents"("createdAt")
    WHERE "status" = 'PENDING' AND "deletedAt" IS NULL;
