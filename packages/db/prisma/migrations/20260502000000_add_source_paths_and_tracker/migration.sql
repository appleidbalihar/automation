-- CreateTable
CREATE TABLE "RagKbFileTracker" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSha" TEXT NOT NULL,
    "difyDocumentId" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagKbFileTracker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RagKbFileTracker_knowledgeBaseId_idx" ON "RagKbFileTracker"("knowledgeBaseId");

-- CreateIndex
CREATE UNIQUE INDEX "RagKbFileTracker_knowledgeBaseId_filePath_key" ON "RagKbFileTracker"("knowledgeBaseId", "filePath");

-- AddForeignKey
ALTER TABLE "RagKbFileTracker" ADD CONSTRAINT "RagKbFileTracker_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "RagKnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "RagKnowledgeBase" ADD COLUMN "sourcePaths" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill sourcePaths with sourcePath if present
UPDATE "RagKnowledgeBase" SET "sourcePaths" = ARRAY["sourcePath"] WHERE "sourcePath" IS NOT NULL AND "sourcePath" != '';
