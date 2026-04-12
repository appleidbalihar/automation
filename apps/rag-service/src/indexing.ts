export interface RagSourceDocument {
  externalId: string;
  title: string;
  text: string;
}

const baseOperationalDocs: RagSourceDocument[] = [
  {
    externalId: "ops-retry-001",
    title: "Retry Guidance",
    text: "Use retry when a single step failed due to transient network issues."
  },
  {
    externalId: "ops-workflow-002",
    title: "Workflow Publish Guidance",
    text: "Workflow publish action creates an immutable execution version."
  },
  {
    externalId: "ops-rollback-003",
    title: "Rollback Guidance",
    text: "Use rollback after partial failure when completed reversible steps must be undone."
  },
  {
    externalId: "ops-checkpoint-004",
    title: "Checkpoint Resume Guidance",
    text: "Resume starts from the last successful checkpoint and skips completed steps by default."
  },
  {
    externalId: "ops-approval-005",
    title: "Approval Queue Guidance",
    text: "Pending approval orders should be reviewed before retry or rollback actions."
  }
];

export function buildSourceDocuments(source: string, requestedDocuments?: number): RagSourceDocument[] {
  const normalized = source.trim().toLowerCase();
  const docs =
    normalized === "workflow-guide"
      ? baseOperationalDocs.filter((doc) => doc.externalId.includes("workflow") || doc.externalId.includes("checkpoint"))
      : normalized === "incident-ops"
        ? baseOperationalDocs.filter((doc) => doc.externalId.includes("retry") || doc.externalId.includes("rollback"))
        : baseOperationalDocs;

  if (typeof requestedDocuments !== "number" || requestedDocuments <= 0) {
    return docs;
  }
  return docs.slice(0, Math.min(requestedDocuments, docs.length));
}
