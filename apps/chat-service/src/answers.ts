import type { ChatQuery, ChatResponse } from "@platform/contracts";

export type ChatOrderContext = {
  id: string;
  status: string;
  currentNodeOrder: number;
  currentStepIndex: number;
  lastError?: string | null;
  checkpoints: Array<{
    nodeOrder: number;
    stepIndex: number;
  }>;
};

export type ChatWorkflowContext = {
  id: string;
  name: string;
  latestVersion?: {
    version: number;
    status: string;
  };
};

const restrictedKeywords = [
  "source code",
  "backend implementation",
  "database schema",
  "internal code",
  "sql query",
  "api internals",
  "microservice code"
];

export function isRestrictedPrompt(query: string): boolean {
  const lower = query.toLowerCase();
  return restrictedKeywords.some((keyword) => lower.includes(keyword));
}

export function buildOperationalAnswer(
  payload: ChatQuery,
  context: {
    order?: ChatOrderContext;
    workflow?: ChatWorkflowContext;
  }
): ChatResponse {
  if (isRestrictedPrompt(payload.query)) {
    return {
      answer: "I can help with operations, workflows, order status interpretation, and troubleshooting. I cannot provide backend or code-level details.",
      citations: ["policy:operational-only"],
      restricted: true
    };
  }

  const lower = payload.query.toLowerCase();
  const answerLines: string[] = [];
  const citations: string[] = [];

  if (payload.orderId) {
    const order = context.order;
    if (order) {
      const lastCheckpoint = order.checkpoints[0];
      answerLines.push(
        `Order ${order.id} is ${order.status} at node ${order.currentNodeOrder}, step ${order.currentStepIndex}.`
      );
      if (lastCheckpoint) {
        answerLines.push(`Last checkpoint is node ${lastCheckpoint.nodeOrder}, step ${lastCheckpoint.stepIndex}.`);
      }
      if (order.lastError) {
        answerLines.push(`Latest failure detail: ${order.lastError}.`);
      }
      citations.push(`order:${order.id}`);
    } else {
      answerLines.push(`Order ${payload.orderId} was not found in current runtime records.`);
    }
  }

  if (payload.workflowId) {
    const workflow = context.workflow;
    if (workflow) {
      answerLines.push(
        `Workflow ${workflow.name} (${workflow.id}) latest version is ${workflow.latestVersion?.version ?? "n/a"} with status ${workflow.latestVersion?.status ?? "n/a"}.`
      );
      citations.push(`workflow:${workflow.id}`);
    } else {
      answerLines.push(`Workflow ${payload.workflowId} was not found.`);
    }
  }

  if (lower.includes("retry")) {
    answerLines.push("Use retry when failures are transient and checkpoint state is valid.");
    citations.push("ops:retry-guidance");
  }

  if (lower.includes("rollback")) {
    answerLines.push("Use rollback when partial execution must be reverted for consistency.");
    citations.push("ops:rollback-guidance");
  }

  if (answerLines.length === 0) {
    answerLines.push(
      "For this operational scenario, check order timeline, identify the failed node/step, and use retry for transient errors or rollback for consistency recovery."
    );
    citations.push("operations-guide", "workflow-guide");
  }

  return {
    answer: answerLines.join(" "),
    citations,
    restricted: false
  };
}
