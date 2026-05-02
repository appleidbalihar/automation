-- Migration: KB Multi-Tenancy & Sharing
-- Removes global scope model, adds ownerUsername, RagKbShare, RagDiscussionKbSession,
-- and kbResults column on RagDiscussionMessage.

-- Step 1: Add ownerUsername column to RagKnowledgeBase (defaults to ownerId for existing rows)
ALTER TABLE "RagKnowledgeBase" ADD COLUMN IF NOT EXISTS "ownerUsername" TEXT;
-- Backfill ownerUsername from ownerId for all existing rows
UPDATE "RagKnowledgeBase" SET "ownerUsername" = "ownerId" WHERE "ownerUsername" IS NULL;
-- Make it non-nullable now that backfill is done
ALTER TABLE "RagKnowledgeBase" ALTER COLUMN "ownerUsername" SET NOT NULL;

-- Step 2: Drop scope column (no longer used — ownership replaces it)
-- First, ensure ownerId is set for any rows that somehow have it null (safety guard)
UPDATE "RagKnowledgeBase" SET "ownerId" = "createdById" WHERE "ownerId" IS NULL OR "ownerId" = '';
ALTER TABLE "RagKnowledgeBase" DROP COLUMN IF EXISTS "scope";

-- Step 3: Create RagKbShare table
CREATE TABLE IF NOT EXISTS "RagKbShare" (
    "id"              TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "sharedWithId"    TEXT NOT NULL,
    "sharedById"      TEXT NOT NULL,
    "permission"      TEXT NOT NULL DEFAULT 'chat',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagKbShare_pkey" PRIMARY KEY ("id")
);

-- Add foreign key from RagKbShare to RagKnowledgeBase (cascade on delete)
ALTER TABLE "RagKbShare"
    ADD CONSTRAINT "RagKbShare_knowledgeBaseId_fkey"
    FOREIGN KEY ("knowledgeBaseId")
    REFERENCES "RagKnowledgeBase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique constraint: one share record per user per KB
CREATE UNIQUE INDEX IF NOT EXISTS "RagKbShare_knowledgeBaseId_sharedWithId_key"
    ON "RagKbShare"("knowledgeBaseId", "sharedWithId");

-- Indexes for share lookups
CREATE INDEX IF NOT EXISTS "RagKbShare_sharedWithId_idx" ON "RagKbShare"("sharedWithId");
CREATE INDEX IF NOT EXISTS "RagKbShare_knowledgeBaseId_idx" ON "RagKbShare"("knowledgeBaseId");

-- Step 4: Create RagDiscussionKbSession table
CREATE TABLE IF NOT EXISTS "RagDiscussionKbSession" (
    "id"                 TEXT NOT NULL,
    "threadId"           TEXT NOT NULL,
    "knowledgeBaseId"    TEXT NOT NULL,
    "knowledgeBaseName"  TEXT NOT NULL,
    "difyConversationId" TEXT,

    CONSTRAINT "RagDiscussionKbSession_pkey" PRIMARY KEY ("id")
);

-- Add foreign key from RagDiscussionKbSession to RagDiscussionThread (cascade on delete)
ALTER TABLE "RagDiscussionKbSession"
    ADD CONSTRAINT "RagDiscussionKbSession_threadId_fkey"
    FOREIGN KEY ("threadId")
    REFERENCES "RagDiscussionThread"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique constraint: one session per KB per thread
CREATE UNIQUE INDEX IF NOT EXISTS "RagDiscussionKbSession_threadId_knowledgeBaseId_key"
    ON "RagDiscussionKbSession"("threadId", "knowledgeBaseId");

-- Index for session lookups by thread
CREATE INDEX IF NOT EXISTS "RagDiscussionKbSession_threadId_idx" ON "RagDiscussionKbSession"("threadId");

-- Step 5: Add kbResults JSON column to RagDiscussionMessage
-- Stores per-KB answers for multi-KB queries: [{knowledgeBaseId, knowledgeBaseName, ownerUsername, answer}]
ALTER TABLE "RagDiscussionMessage" ADD COLUMN IF NOT EXISTS "kbResults" JSONB;

-- Step 6: Drop the old @@index([ownerId, scope]) index on RagKnowledgeBase (scope no longer exists)
DROP INDEX IF EXISTS "RagKnowledgeBase_ownerId_scope_idx";

-- Step 7: Add new index on ownerId alone for RagKnowledgeBase
CREATE INDEX IF NOT EXISTS "RagKnowledgeBase_ownerId_idx" ON "RagKnowledgeBase"("ownerId");
