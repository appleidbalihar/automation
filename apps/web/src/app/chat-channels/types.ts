import type {
  ChannelChatHistoryResponse,
  ChannelChatThreadSummary,
  SlackDeployment,
  SlackDeploymentActivateRequest,
  SlackUserKbMapping
} from "@platform/contracts";

export type {
  ChannelChatHistoryResponse,
  ChannelChatThreadSummary,
  SlackDeployment,
  SlackDeploymentActivateRequest,
  SlackUserKbMapping
};

export interface RagKnowledgeBaseOption {
  id: string;
  name: string;
  ownerUsername?: string;
  sourceType?: string;
}
