-- AddColumn: rerankingEnabled to RagKnowledgeBaseConfig
-- null = follow platform/global/reranker Vault default; true/false = explicit per-KB override
ALTER TABLE "RagKnowledgeBaseConfig" ADD COLUMN "rerankingEnabled" BOOLEAN;
