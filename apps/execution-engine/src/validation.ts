import type { WorkflowNode } from "@platform/contracts";

export function validateWorkflowNodes(nodes: WorkflowNode[]): string[] {
  const errors: string[] = [];
  const seenNodeOrders = new Set<number>();
  const seenNodeIds = new Set<string>();

  nodes.forEach((node, index) => {
    if (seenNodeIds.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`);
    }
    seenNodeIds.add(node.id);

    if (seenNodeOrders.has(node.order)) {
      errors.push(`Duplicate node order: ${node.order}`);
    }
    seenNodeOrders.add(node.order);

    if (node.order !== index) {
      errors.push(`Node order sequence mismatch at node ${node.id}: expected ${index}, got ${node.order}`);
    }
    if (!Array.isArray(node.steps) || node.steps.length === 0) {
      errors.push(`Node ${node.id} must contain at least one step`);
    }

    const seenStepIds = new Set<string>();
    node.steps.forEach((step) => {
      if (seenStepIds.has(step.id)) {
        errors.push(`Duplicate step id ${step.id} in node ${node.id}`);
      }
      seenStepIds.add(step.id);
      if (!step.commandRef || !step.commandRef.trim()) {
        errors.push(`Step ${step.id} in node ${node.id} requires commandRef`);
      }
      if (step.retryPolicy.maxRetries < 0) {
        errors.push(`Step ${step.id} in node ${node.id} has invalid maxRetries`);
      }
      if (step.retryPolicy.backoffMs < 0) {
        errors.push(`Step ${step.id} in node ${node.id} has invalid backoffMs`);
      }
    });
  });

  return errors;
}
