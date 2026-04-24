CREATE TABLE "ExecutionLog" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "executionId" TEXT,
    "workflowId" TEXT,
    "workflowVersionId" TEXT,
    "nodeId" TEXT,
    "stepId" TEXT,
    "taskId" TEXT,
    "initiatedBy" TEXT,
    "severity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "maskedPayload" JSONB,
    "message" TEXT NOT NULL,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExecutionLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RagDiscussionThread" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "flowiseSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RagDiscussionThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RagDiscussionMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RagDiscussionMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExecutionLog_orderId_createdAt_idx" ON "ExecutionLog"("orderId", "createdAt");
CREATE INDEX "ExecutionLog_executionId_createdAt_idx" ON "ExecutionLog"("executionId", "createdAt");
CREATE INDEX "ExecutionLog_workflowId_workflowVersionId_createdAt_idx" ON "ExecutionLog"("workflowId", "workflowVersionId", "createdAt");
CREATE UNIQUE INDEX "RagDiscussionThread_flowiseSessionId_key" ON "RagDiscussionThread"("flowiseSessionId");
CREATE INDEX "RagDiscussionThread_ownerId_lastMessageAt_idx" ON "RagDiscussionThread"("ownerId", "lastMessageAt");
CREATE INDEX "RagDiscussionThread_expiresAt_idx" ON "RagDiscussionThread"("expiresAt");
CREATE INDEX "RagDiscussionMessage_threadId_createdAt_idx" ON "RagDiscussionMessage"("threadId", "createdAt");

ALTER TABLE "RagDiscussionMessage"
ADD CONSTRAINT "RagDiscussionMessage_threadId_fkey"
FOREIGN KEY ("threadId") REFERENCES "RagDiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
