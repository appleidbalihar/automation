-- Alter integration profile for auth + lifecycle management
ALTER TABLE "IntegrationProfile"
ADD COLUMN "authType" TEXT NOT NULL DEFAULT 'API_KEY',
ADD COLUMN "lifecycleState" TEXT NOT NULL DEFAULT 'ACTIVE';

-- Integration sharing
CREATE TABLE "IntegrationShare" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntegrationShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationShare_integrationId_sharedWithUserId_key" ON "IntegrationShare"("integrationId", "sharedWithUserId");
CREATE INDEX "IntegrationShare_sharedWithUserId_createdAt_idx" ON "IntegrationShare"("sharedWithUserId", "createdAt");

ALTER TABLE "IntegrationShare"
ADD CONSTRAINT "IntegrationShare_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "IntegrationProfile"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Environment sharing
CREATE TABLE "EnvironmentShare" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnvironmentShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EnvironmentShare_environmentId_sharedWithUserId_key" ON "EnvironmentShare"("environmentId", "sharedWithUserId");
CREATE INDEX "EnvironmentShare_sharedWithUserId_createdAt_idx" ON "EnvironmentShare"("sharedWithUserId", "createdAt");

ALTER TABLE "EnvironmentShare"
ADD CONSTRAINT "EnvironmentShare_environmentId_fkey"
FOREIGN KEY ("environmentId") REFERENCES "UserEnvironment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
