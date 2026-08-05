-- ---------------------------------------------------------------------------
-- Legal chat.
--
-- Questions answered from retrieved sources rather than from the model's own
-- memory. Both halves of the retrieval are searched: the shared statute corpus
-- (cited by article) and the asking company's own scans (private, cited by
-- document) — which is why a conversation is tenant-scoped even though the law
-- is not.
-- ---------------------------------------------------------------------------

CREATE TYPE "ChatRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "chat_conversations" (
    "id"        TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- The sidebar query: this user's threads, most recent first.
CREATE INDEX "chat_conversations_companyId_userId_updatedAt_idx"
    ON "chat_conversations"("companyId", "userId", "updatedAt");

CREATE TABLE "chat_messages" (
    "id"             TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role"           "ChatRole" NOT NULL,
    "content"        TEXT NOT NULL,
    -- The sources the answer cited, resolved to a citation string at write
    -- time. Denormalised on purpose: an answer must keep reading the same way
    -- a year later even if the corpus has been re-ingested and the chunk ids
    -- have moved.
    "citations"      JSONB,
    "provider"       TEXT,
    "model"          TEXT,
    "ungrounded"     BOOLEAN NOT NULL DEFAULT false,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_messages_conversationId_createdAt_idx"
    ON "chat_messages"("conversationId", "createdAt");

ALTER TABLE "chat_conversations"
    ADD CONSTRAINT "chat_conversations_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_conversations"
    ADD CONSTRAINT "chat_conversations_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_messages"
    ADD CONSTRAINT "chat_messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "chat_conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
