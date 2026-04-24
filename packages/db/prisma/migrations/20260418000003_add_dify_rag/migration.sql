-- Migration: 20260418000003_add_dify_rag
-- Adds Dify RAG multi-tenant models:
--   RagKnowledgeBase        — user-configured knowledge sources
--   RagKnowledgeBaseConfig  — per-KB AI config (admin defaults + user overrides)
--   RagKbSyncJob            — document sync progress tracking
--   RagChannelDeployment    — channel delivery tracking (Phase 2)
-- Updates RagDiscussionThread with:
--   knowledgeBaseId         — FK to RagKnowledgeBase (nullable, null = legacy Flowise)
--   difyConversationId      — Dify conversation_id for session continuity (nullable)

-- ─── RagKnowledgeBase ────────────────────────────────────────────────────────
CREATE TABLE "RagKnowledgeBase" (
    "id"            TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "description"   TEXT,

    -- Document source config (non-secret; credentials in Vault)
    "sourceType"    TEXT NOT NULL,
    "sourceUrl"     TEXT NOT NULL,
    "sourceBranch"  TEXT,
    "sourcePath"    TEXT,
    "syncSchedule"  TEXT,

    -- Dify app config (non-secret; API key in Vault)
    "difyAppUrl"    TEXT NOT NULL DEFAULT 'http://dify-api:5001',
    "difyDatasetId" TEXT,

    -- Scope and ownership
    "scope"         TEXT NOT NULL DEFAULT 'global',
    "ownerId"       TEXT,
    "isDefault"     BOOLEAN NOT NULL DEFAULT false,
    "createdById"   TEXT NOT NULL,

    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagKnowledgeBase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RagKnowledgeBase_ownerId_scope_idx"  ON "RagKnowledgeBase"("ownerId", "scope");
CREATE INDEX "RagKnowledgeBase_isDefault_idx"       ON "RagKnowledgeBase"("isDefault");
CREATE INDEX "RagKnowledgeBase_createdById_idx"     ON "RagKnowledgeBase"("createdById");

-- ─── RagKnowledgeBaseConfig ──────────────────────────────────────────────────
CREATE TABLE "RagKnowledgeBaseConfig" (
    "id"                TEXT NOT NULL,
    "knowledgeBaseId"   TEXT NOT NULL,

    -- Admin-controlled defaults
    "systemPromptBase"  TEXT,
    "llmModel"          TEXT,
    "temperature"       DOUBLE PRECISION,
    "topK"              INTEGER,

    -- User-customizable overrides
    "responseStyle"     TEXT,
    "toneInstructions"  TEXT,
    "restrictionRules"  TEXT,
    "welcomeMessage"    TEXT,

    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagKnowledgeBaseConfig_pkey"            PRIMARY KEY ("id"),
    CONSTRAINT "RagKnowledgeBaseConfig_kbId_unique"     UNIQUE ("knowledgeBaseId"),
    CONSTRAINT "RagKnowledgeBaseConfig_kb_fk"           FOREIGN KEY ("knowledgeBaseId")
        REFERENCES "RagKnowledgeBase"("id") ON DELETE CASCADE
);

CREATE INDEX "RagKnowledgeBaseConfig_knowledgeBaseId_idx" ON "RagKnowledgeBaseConfig"("knowledgeBaseId");

-- ─── RagKbSyncJob ────────────────────────────────────────────────────────────
CREATE TABLE "RagKbSyncJob" (
    "id"                TEXT NOT NULL,
    "knowledgeBaseId"   TEXT NOT NULL,

    "trigger"           TEXT NOT NULL,          -- "manual" | "scheduled" | "webhook"
    "triggeredById"     TEXT,
    "status"            TEXT NOT NULL DEFAULT 'pending',

    -- Progress (updated by n8n webhook callbacks)
    "filesTotal"        INTEGER,
    "filesProcessed"    INTEGER NOT NULL DEFAULT 0,
    "chunksTotal"       INTEGER,
    "chunksProcessed"   INTEGER NOT NULL DEFAULT 0,
    "errorMessage"      TEXT,

    -- n8n traceability
    "n8nExecutionId"    TEXT,
    "n8nWebhookUrl"     TEXT,

    "startedAt"         TIMESTAMP(3),
    "completedAt"       TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagKbSyncJob_pkey"      PRIMARY KEY ("id"),
    CONSTRAINT "RagKbSyncJob_kb_fk"     FOREIGN KEY ("knowledgeBaseId")
        REFERENCES "RagKnowledgeBase"("id") ON DELETE CASCADE
);

CREATE INDEX "RagKbSyncJob_knowledgeBaseId_createdAt_idx" ON "RagKbSyncJob"("knowledgeBaseId", "createdAt");
CREATE INDEX "RagKbSyncJob_status_idx"                    ON "RagKbSyncJob"("status");
CREATE INDEX "RagKbSyncJob_triggeredById_idx"             ON "RagKbSyncJob"("triggeredById");

-- ─── RagChannelDeployment ────────────────────────────────────────────────────
CREATE TABLE "RagChannelDeployment" (
    "id"              TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,

    "channelType"     TEXT NOT NULL,
    "channelName"     TEXT NOT NULL,
    "n8nWorkflowId"   TEXT,
    "status"          TEXT NOT NULL DEFAULT 'pending',
    "ownerId"         TEXT NOT NULL,
    "errorMessage"    TEXT,

    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagChannelDeployment_pkey"  PRIMARY KEY ("id"),
    CONSTRAINT "RagChannelDeployment_kb_fk" FOREIGN KEY ("knowledgeBaseId")
        REFERENCES "RagKnowledgeBase"("id") ON DELETE CASCADE
);

CREATE INDEX "RagChannelDeployment_ownerId_channelType_idx" ON "RagChannelDeployment"("ownerId", "channelType");
CREATE INDEX "RagChannelDeployment_knowledgeBaseId_idx"     ON "RagChannelDeployment"("knowledgeBaseId");
CREATE INDEX "RagChannelDeployment_status_idx"              ON "RagChannelDeployment"("status");

-- ─── RagDiscussionThread: add Dify columns ───────────────────────────────────
-- knowledgeBaseId: links thread to a KB (null = legacy Flowise thread)
-- difyConversationId: Dify's own conversation_id for session continuity
ALTER TABLE "RagDiscussionThread"
    ADD COLUMN "knowledgeBaseId"    TEXT,
    ADD COLUMN "difyConversationId" TEXT;

-- FK: if KB is deleted, set thread's knowledgeBaseId to null (keep thread data)
ALTER TABLE "RagDiscussionThread"
    ADD CONSTRAINT "RagDiscussionThread_kb_fk"
        FOREIGN KEY ("knowledgeBaseId")
        REFERENCES "RagKnowledgeBase"("id") ON DELETE SET NULL;

CREATE INDEX "RagDiscussionThread_knowledgeBaseId_idx" ON "RagDiscussionThread"("knowledgeBaseId");
