-- AddColumns: hallucinationGuardEnabled and hallucinationThreshold to RagKnowledgeBaseConfig
-- Both have defaults so existing rows get safe values without a backfill.
ALTER TABLE "RagKnowledgeBaseConfig"
  ADD COLUMN "hallucinationGuardEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "hallucinationThreshold"    DOUBLE PRECISION NOT NULL DEFAULT 0.3;
