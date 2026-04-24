-- Add stepsJson column for dynamic workflow step tracking
ALTER TABLE "RagKbSyncJob" ADD COLUMN IF NOT EXISTS "stepsJson" JSONB;
