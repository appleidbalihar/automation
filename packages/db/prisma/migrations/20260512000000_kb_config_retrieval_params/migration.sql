-- Add scoreThreshold to RagKnowledgeBaseConfig for UI-configurable retrieval quality control
ALTER TABLE "RagKnowledgeBaseConfig" ADD COLUMN "scoreThreshold" DOUBLE PRECISION;
