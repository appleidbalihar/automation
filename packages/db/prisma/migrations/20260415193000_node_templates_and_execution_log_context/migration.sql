ALTER TABLE "ExecutionLog"
ADD COLUMN "executionId" TEXT,
ADD COLUMN "workflowId" TEXT,
ADD COLUMN "workflowVersionId" TEXT,
ADD COLUMN "taskId" TEXT,
ADD COLUMN "initiatedBy" TEXT;

CREATE INDEX "ExecutionLog_orderId_createdAt_idx" ON "ExecutionLog"("orderId", "createdAt");
CREATE INDEX "ExecutionLog_executionId_createdAt_idx" ON "ExecutionLog"("executionId", "createdAt");
CREATE INDEX "ExecutionLog_workflowId_workflowVersionId_createdAt_idx" ON "ExecutionLog"("workflowId", "workflowVersionId", "createdAt");

CREATE TABLE "NodeTemplate" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "tagsJson" JSONB,
    "nodeType" TEXT NOT NULL,
    "configJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NodeTemplateShare" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeTemplateShare_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NodeTemplate_ownerId_updatedAt_idx" ON "NodeTemplate"("ownerId", "updatedAt");
CREATE INDEX "NodeTemplate_nodeType_updatedAt_idx" ON "NodeTemplate"("nodeType", "updatedAt");
CREATE UNIQUE INDEX "NodeTemplateShare_templateId_sharedWithUserId_key" ON "NodeTemplateShare"("templateId", "sharedWithUserId");
CREATE INDEX "NodeTemplateShare_sharedWithUserId_createdAt_idx" ON "NodeTemplateShare"("sharedWithUserId", "createdAt");

ALTER TABLE "NodeTemplateShare"
ADD CONSTRAINT "NodeTemplateShare_templateId_fkey"
FOREIGN KEY ("templateId") REFERENCES "NodeTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
