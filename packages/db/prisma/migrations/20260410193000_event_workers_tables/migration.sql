-- CreateTable
CREATE TABLE "WorkflowPublishAudit" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "correlationId" TEXT,
    "eventTimestamp" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowPublishAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RagIndexJob" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "correlationId" TEXT,
    "requestedDocuments" INTEGER,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RagIndexJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowPublishAudit_workflowVersionId_key" ON "WorkflowPublishAudit"("workflowVersionId");
