import type {
  ChannelChatHistoryResponse,
  ChannelChatThreadSummary,
  SlackDeployment,
  SlackDeploymentActivateRequest
} from "@platform/contracts";

export type {
  ChannelChatHistoryResponse,
  ChannelChatThreadSummary,
  SlackDeployment,
  SlackDeploymentActivateRequest
};

export interface RagKnowledgeBaseOption {
  id: string;
  name: string;
  ownerUsername?: string;
  sourceType?: string;
}
