-- Slack Phase 1 direct chat-channel deployment.

COMMENT ON TABLE "RagChannelDeployment" IS 'Legacy n8n-oriented single-KB channel deployment stub. Real-time Slack uses SlackDeployment.';

CREATE TABLE "SlackDeployment" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "deploymentName" TEXT NOT NULL,
    "installMode" TEXT NOT NULL DEFAULT 'oauth',
    "slackWorkspaceId" TEXT,
    "slackWorkspaceName" TEXT,
    "slackBotUserId" TEXT,
    "slackChannelId" TEXT,
    "slackChannelName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "accessMode" TEXT NOT NULL DEFAULT 'channel',
    "allowedSlackUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackDeployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SlackDeploymentKb" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,

    CONSTRAINT "SlackDeploymentKb_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelChatThread" (
    "id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "externalThreadKey" TEXT NOT NULL,
    "channelDeploymentId" TEXT,
    "externalUserId" TEXT,
    "activeKbIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelChatThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "kbResults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelChatKbSession" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "knowledgeBaseName" TEXT NOT NULL,
    "difyConversationId" TEXT,

    CONSTRAINT "ChannelChatKbSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SlackDeployment_ownerId_idx" ON "SlackDeployment"("ownerId");
CREATE INDEX "SlackDeployment_slackWorkspaceId_idx" ON "SlackDeployment"("slackWorkspaceId");
CREATE INDEX "SlackDeployment_status_idx" ON "SlackDeployment"("status");

CREATE INDEX "SlackDeploymentKb_deploymentId_idx" ON "SlackDeploymentKb"("deploymentId");
CREATE INDEX "SlackDeploymentKb_knowledgeBaseId_idx" ON "SlackDeploymentKb"("knowledgeBaseId");
CREATE UNIQUE INDEX "SlackDeploymentKb_deploymentId_knowledgeBaseId_key" ON "SlackDeploymentKb"("deploymentId", "knowledgeBaseId");

CREATE INDEX "ChannelChatThread_channelDeploymentId_idx" ON "ChannelChatThread"("channelDeploymentId");
CREATE INDEX "ChannelChatThread_origin_lastMessageAt_idx" ON "ChannelChatThread"("origin", "lastMessageAt");
CREATE INDEX "ChannelChatThread_expiresAt_idx" ON "ChannelChatThread"("expiresAt");
CREATE UNIQUE INDEX "ChannelChatThread_origin_channelDeploymentId_externalThread_key" ON "ChannelChatThread"("origin", "channelDeploymentId", "externalThreadKey");

CREATE INDEX "ChannelChatMessage_threadId_createdAt_idx" ON "ChannelChatMessage"("threadId", "createdAt");

CREATE INDEX "ChannelChatKbSession_threadId_idx" ON "ChannelChatKbSession"("threadId");
CREATE UNIQUE INDEX "ChannelChatKbSession_threadId_knowledgeBaseId_key" ON "ChannelChatKbSession"("threadId", "knowledgeBaseId");

ALTER TABLE "SlackDeploymentKb" ADD CONSTRAINT "SlackDeploymentKb_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "SlackDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SlackDeploymentKb" ADD CONSTRAINT "SlackDeploymentKb_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "RagKnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelChatThread" ADD CONSTRAINT "ChannelChatThread_channelDeploymentId_fkey" FOREIGN KEY ("channelDeploymentId") REFERENCES "SlackDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelChatMessage" ADD CONSTRAINT "ChannelChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChannelChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelChatKbSession" ADD CONSTRAINT "ChannelChatKbSession_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChannelChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
