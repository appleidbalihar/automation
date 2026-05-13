-- RagChatEvent: one row per RAG request, capturing retrieval quality and answer outcome.
-- Fire-and-forget from workflow-service; never blocks the chat response.
CREATE TABLE "RagChatEvent" (
    "id"                       TEXT NOT NULL,
    "knowledgeBaseId"          TEXT NOT NULL,
    "threadId"                 TEXT,
    "channel"                  TEXT NOT NULL,
    "questionLen"              INTEGER NOT NULL,
    "retrievedChunkCount"      INTEGER NOT NULL,
    "avgChunkScore"            DOUBLE PRECISION,
    "topChunkScore"            DOUBLE PRECISION,
    "hallucinationGuardScore"  DOUBLE PRECISION,
    "hallucinationBlocked"     BOOLEAN NOT NULL DEFAULT false,
    "fallbackUsed"             BOOLEAN NOT NULL DEFAULT false,
    "fallbackType"             TEXT,
    "difyCallMs"               INTEGER NOT NULL,
    "totalMs"                  INTEGER NOT NULL,
    "answerLen"                INTEGER NOT NULL,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagChatEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RagChatEvent_knowledgeBaseId_createdAt_idx" ON "RagChatEvent"("knowledgeBaseId", "createdAt");
CREATE INDEX "RagChatEvent_createdAt_idx" ON "RagChatEvent"("createdAt");
