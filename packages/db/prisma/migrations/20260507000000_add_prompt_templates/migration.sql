-- Migration: Add SystemPromptTemplate + SystemPromptTemplateShare models
-- and templateId FK on RagKnowledgeBase
-- 2026-05-07

-- ── SystemPromptTemplate ──────────────────────────────────────────────────────
CREATE TABLE "SystemPromptTemplate" (
    "id"               TEXT NOT NULL,
    "name"             TEXT NOT NULL,
    "description"      TEXT,
    "category"         TEXT NOT NULL,
    "systemPromptBase" TEXT NOT NULL,
    "responseStyle"    TEXT,
    "toneInstructions" TEXT,
    "restrictionRules" TEXT,
    "ownerId"          TEXT NOT NULL,
    "ownerUsername"    TEXT NOT NULL,
    "isBuiltIn"        BOOLEAN NOT NULL DEFAULT false,
    "shareScope"       TEXT NOT NULL DEFAULT 'private',
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemPromptTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SystemPromptTemplate_ownerId_idx"    ON "SystemPromptTemplate"("ownerId");
CREATE INDEX "SystemPromptTemplate_shareScope_idx" ON "SystemPromptTemplate"("shareScope");
CREATE INDEX "SystemPromptTemplate_category_idx"   ON "SystemPromptTemplate"("category");
CREATE INDEX "SystemPromptTemplate_isBuiltIn_idx"  ON "SystemPromptTemplate"("isBuiltIn");

-- ── SystemPromptTemplateShare ─────────────────────────────────────────────────
CREATE TABLE "SystemPromptTemplateShare" (
    "id"           TEXT NOT NULL,
    "templateId"   TEXT NOT NULL,
    "sharedWithId" TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemPromptTemplateShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SystemPromptTemplateShare_templateId_sharedWithId_key"
    ON "SystemPromptTemplateShare"("templateId", "sharedWithId");
CREATE INDEX "SystemPromptTemplateShare_sharedWithId_idx"
    ON "SystemPromptTemplateShare"("sharedWithId");

ALTER TABLE "SystemPromptTemplateShare"
    ADD CONSTRAINT "SystemPromptTemplateShare_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "SystemPromptTemplate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── templateId FK on RagKnowledgeBase ────────────────────────────────────────
ALTER TABLE "RagKnowledgeBase"
    ADD COLUMN "templateId" TEXT;

CREATE INDEX "RagKnowledgeBase_templateId_idx" ON "RagKnowledgeBase"("templateId");

ALTER TABLE "RagKnowledgeBase"
    ADD CONSTRAINT "RagKnowledgeBase_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "SystemPromptTemplate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
