-- Add lastProgressAt to RagKbSyncJob for accurate stale-job detection
ALTER TABLE "RagKbSyncJob" ADD COLUMN "lastProgressAt" TIMESTAMP(3);
