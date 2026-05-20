-- Add multi-user sharing and access-mode fields to SlackDeployment
ALTER TABLE "SlackDeployment" ADD COLUMN IF NOT EXISTS "shareScope" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "SlackDeployment" ADD COLUMN IF NOT EXISTS "sharedWithUserIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "SlackDeployment" ADD COLUMN IF NOT EXISTS "requireUserVerification" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SlackDeployment" ADD COLUMN IF NOT EXISTS "defaultKbIds" TEXT[] NOT NULL DEFAULT '{}';

-- Index for fast shared-deployment lookup
CREATE INDEX IF NOT EXISTS "SlackDeployment_shareScope_idx" ON "SlackDeployment"("shareScope");

-- New table: per-user Slack ID → KB mapping for verified-mode deployments
CREATE TABLE IF NOT EXISTS "SlackUserKbMapping" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "rapidragUserId" TEXT,
    "rapidragUsername" TEXT,
    "slackUserId" TEXT NOT NULL,
    "kbIds" TEXT[] NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'connected',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackUserKbMapping_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one mapping per (deployment, slackUser)
CREATE UNIQUE INDEX IF NOT EXISTS "SlackUserKbMapping_deploymentId_slackUserId_key"
    ON "SlackUserKbMapping"("deploymentId", "slackUserId");

CREATE INDEX IF NOT EXISTS "SlackUserKbMapping_deploymentId_idx" ON "SlackUserKbMapping"("deploymentId");
CREATE INDEX IF NOT EXISTS "SlackUserKbMapping_rapidragUserId_idx" ON "SlackUserKbMapping"("rapidragUserId");

-- Foreign key to SlackDeployment
ALTER TABLE "SlackUserKbMapping"
    ADD CONSTRAINT "SlackUserKbMapping_deploymentId_fkey"
    FOREIGN KEY ("deploymentId") REFERENCES "SlackDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
