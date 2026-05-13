-- H3+H4: RAG Answer Quality Metrics — RAGAS-style async faithfulness/relevance scoring
CREATE TABLE "RagAnswerQualityLog" (
    "id"              TEXT NOT NULL,
    "threadId"        TEXT NOT NULL,
    "messageId"       TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "question"        TEXT NOT NULL,
    "faithfulness"    DOUBLE PRECISION,
    "relevance"       DOUBLE PRECISION,
    "evaluatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagAnswerQualityLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RagAnswerQualityLog_knowledgeBaseId_evaluatedAt_idx" ON "RagAnswerQualityLog"("knowledgeBaseId", "evaluatedAt");
CREATE INDEX "RagAnswerQualityLog_threadId_idx" ON "RagAnswerQualityLog"("threadId");
