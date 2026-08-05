-- ---------------------------------------------------------------------------
-- Legislation corpus.
--
-- The retrieval half of "answers grounded in Uzbek law". `document_chunks`
-- already indexes each tenant's own uploaded scans; this indexes the statute
-- book itself, shared by every tenant and cited rather than quoted.
--
-- No `companyId` anywhere below, and that is the point: legislation is the same
-- for everyone. A per-tenant copy would multiply the embedding bill by the
-- customer count and make "is this article in force" answerable differently
-- depending on who asks.
-- ---------------------------------------------------------------------------

CREATE TYPE "LegalActType" AS ENUM (
    'CONSTITUTION',
    'CODE',
    'LAW',
    'PRESIDENTIAL_DECREE',
    'PRESIDENTIAL_RESOLUTION',
    'CABINET_RESOLUTION',
    'MINISTERIAL_ACT',
    'COURT_PRACTICE',
    'OTHER'
);

CREATE TYPE "LegalActStatus" AS ENUM (
    'IN_FORCE',
    'AMENDED',
    'REPEALED',
    'UNKNOWN'
);

CREATE TABLE "legal_acts" (
    "id"            TEXT NOT NULL,
    "source"        TEXT NOT NULL,
    "externalId"    TEXT NOT NULL,
    "url"           TEXT,
    "type"          "LegalActType" NOT NULL,
    "number"        TEXT,
    "title"         TEXT NOT NULL,
    "language"      TEXT NOT NULL,
    "adoptedAt"     TIMESTAMP(3),
    "effectiveFrom" TIMESTAMP(3),
    "status"        "LegalActStatus" NOT NULL DEFAULT 'UNKNOWN',
    "revision"      TEXT,
    "content"       TEXT NOT NULL,
    "ingestedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "retiredAt"     TIMESTAMP(3),

    CONSTRAINT "legal_acts_pkey" PRIMARY KEY ("id")
);

-- One row per act per language: the Uzbek Latin, Uzbek Cyrillic, and Russian
-- texts are separate official texts with their own article wording.
CREATE UNIQUE INDEX "legal_acts_source_externalId_language_key"
    ON "legal_acts"("source", "externalId", "language");

CREATE INDEX "legal_acts_type_status_idx" ON "legal_acts"("type", "status");
CREATE INDEX "legal_acts_status_retiredAt_idx" ON "legal_acts"("status", "retiredAt");

CREATE TABLE "legal_act_chunks" (
    "id"             TEXT NOT NULL,
    "actId"          TEXT NOT NULL,
    "chunkIndex"     INTEGER NOT NULL,
    "articleLabel"   TEXT,
    "articlePart"    INTEGER,
    "content"        TEXT NOT NULL,
    "tokenCount"     INTEGER NOT NULL,
    "embeddingModel" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_act_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "legal_act_chunks_actId_chunkIndex_key"
    ON "legal_act_chunks"("actId", "chunkIndex");

CREATE INDEX "legal_act_chunks_actId_articleLabel_idx"
    ON "legal_act_chunks"("actId", "articleLabel");

ALTER TABLE "legal_act_chunks"
    ADD CONSTRAINT "legal_act_chunks_actId_fkey"
    FOREIGN KEY ("actId") REFERENCES "legal_acts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Semantic retrieval.
--
-- pgvector is already installed by the OCR migration. Same 1536 dimensions and
-- the same HNSW/cosine pairing as `document_chunks`, deliberately: one query
-- can then fuse hits from both corpora without reconciling two distance scales.
-- ---------------------------------------------------------------------------
ALTER TABLE "legal_act_chunks" ADD COLUMN "embedding" vector(1536);

CREATE INDEX "legal_act_chunks_embedding_hnsw_idx"
    ON "legal_act_chunks"
    USING hnsw ("embedding" vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Lexical retrieval.
--
-- 'simple' again, not 'russian'. The full reasoning is in the
-- 20260730150000_ocr_and_hybrid_search migration; the short version is that
-- PostgreSQL ships no Uzbek configuration, a single stemmer is wrong for part
-- of nearly every Uzbek legal text, and a GENERATED column requires an
-- IMMUTABLE expression so per-row configuration is unavailable anyway.
--
-- It matters more here than it did there. Statute text is precisely where exact
-- token matching earns its keep: someone searching "347-modda" wants that
-- article, and a stemmer has nothing useful to contribute to a number.
-- ---------------------------------------------------------------------------
ALTER TABLE "legal_act_chunks"
    ADD COLUMN "searchVector" tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce("content", ''))) STORED;

CREATE INDEX "legal_act_chunks_search_vector_gin_idx"
    ON "legal_act_chunks"
    USING gin ("searchVector");
