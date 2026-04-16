-- CreateTable
CREATE TABLE "RagDiscussionThread" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "flowiseSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RagDiscussionThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RagDiscussionMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagDiscussionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RagDiscussionThread_flowiseSessionId_key" ON "RagDiscussionThread"("flowiseSessionId");

-- CreateIndex
CREATE INDEX "RagDiscussionThread_ownerId_lastMessageAt_idx" ON "RagDiscussionThread"("ownerId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "RagDiscussionThread_expiresAt_idx" ON "RagDiscussionThread"("expiresAt");

-- CreateIndex
CREATE INDEX "RagDiscussionMessage_threadId_createdAt_idx" ON "RagDiscussionMessage"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "RagDiscussionMessage" ADD CONSTRAINT "RagDiscussionMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "RagDiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
