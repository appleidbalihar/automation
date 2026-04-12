-- AlterTable
ALTER TABLE "Order"
ADD COLUMN "environmentId" TEXT,
ADD COLUMN "envSnapshotJson" JSONB;

-- CreateTable
CREATE TABLE "IntegrationProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "executionType" TEXT NOT NULL,
    "baseConfigJson" JSONB,
    "credentialJson" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEnvironment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "variablesJson" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationProfile_ownerId_updatedAt_idx" ON "IntegrationProfile"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "UserEnvironment_ownerId_updatedAt_idx" ON "UserEnvironment"("ownerId", "updatedAt");
