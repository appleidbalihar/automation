export type SyncJob = {
  id: string;
  status: string;
  errorMessage: string | null;
  filesTotal?: number | null;
  filesProcessed?: number;
  chunksTotal?: number | null;
  chunksProcessed?: number;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  stepsJson?: unknown;
};

export type FailedDifyDocument = {
  filePath?: string;
  difyDocId?: string;
  batchId?: string;
  indexingStatus?: string;
  error?: string;
  retryable?: boolean;
};

export type Integration = {
  id: string;
  name: string;
  projectName: string | null;
  description: string | null;
  sourceType: string;
  sourceUrl: string;
  sourceBranch: string | null;
  sourcePath: string | null;
  sourcePaths: string[] | null;
  syncSchedule: string | null;
  credentialConfigured: boolean;
  chatReady: boolean;
  syncReady: boolean;
  workflowAssigned: boolean;
  isDefault: boolean;
  latestSyncJob: SyncJob | null;
  authMethod: "oauth" | "pat" | null;
  oauthAppConfigured: boolean;
};

export type IntegrationForm = {
  name: string;
  projectName: string;
  description: string;
  sourceType: "github" | "gitlab" | "googledrive" | "web";
  sourceUrl: string;
  sourceBranch: string;
  sourcePaths: string[];
  githubToken: string;
  gitlabToken: string;
  googleDriveAccessToken: string;
  googleDriveRefreshToken: string;
  setDefault: boolean;
};

export const EMPTY_FORM: IntegrationForm = {
  name: "",
  projectName: "",
  description: "",
  sourceType: "github",
  sourceUrl: "",
  sourceBranch: "main",
  sourcePaths: ["docs/"],
  githubToken: "",
  gitlabToken: "",
  googleDriveAccessToken: "",
  googleDriveRefreshToken: "",
  setDefault: true
};

export type NormalizedSyncStep = {
  key: string;
  task: string;
  /** Value to pass to GET /logs/sync-job?stepName= (matches n8n `stepName` when present). */
  logStepName: string;
  status: string;
  startedAt: string | null;
  durationLabel: string;
  errorMessage: string | null;
  failedDocuments: FailedDifyDocument[];
};

export function formatDate(value?: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function readinessLabel(ready: boolean, positive: string, negative: string): string {
  return ready ? positive : negative;
}

export function syncDisabledReason(integration: Integration): string {
  if (!integration.workflowAssigned) return "Workflow not assigned";
  return "Dify not provisioned";
}

export function normalizeRepositoryInput(url: string, current: IntegrationForm): Partial<IntegrationForm> {
  const trimmed = url.trim();
  const gitlabTreeMatch = trimmed.match(/^(https?:\/\/gitlab\.com\/.+?)\/-\/tree\/([^/]+)\/?(.*)$/i);
  if (gitlabTreeMatch) {
    const detectedPath = gitlabTreeMatch[3];
    return {
      sourceType: "gitlab",
      sourceUrl: gitlabTreeMatch[1],
      sourceBranch: gitlabTreeMatch[2] || current.sourceBranch,
      // Only replace the first path entry if a path was detected in the URL
      sourcePaths: detectedPath ? [detectedPath, ...current.sourcePaths.slice(1)] : current.sourcePaths
    };
  }

  const githubTreeMatch = trimmed.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)\/?(.*)$/i);
  if (githubTreeMatch) {
    const detectedPath = githubTreeMatch[3];
    return {
      sourceType: "github",
      sourceUrl: githubTreeMatch[1],
      sourceBranch: githubTreeMatch[2] || current.sourceBranch,
      // Only replace the first path entry if a path was detected in the URL
      sourcePaths: detectedPath ? [detectedPath, ...current.sourcePaths.slice(1)] : current.sourcePaths
    };
  }

  if (/^https?:\/\/gitlab\.com\//i.test(trimmed)) {
    return { sourceType: "gitlab", sourceUrl: trimmed };
  }
  if (/^https?:\/\/github\.com\//i.test(trimmed)) {
    return { sourceType: "github", sourceUrl: trimmed };
  }
  if (/^https?:\/\/(drive|docs)\.google\.com\//i.test(trimmed)) {
    return { sourceType: "googledrive", sourceUrl: trimmed };
  }

  return { sourceUrl: url };
}

function pickDurationMs(o: Record<string, unknown>): number | null {
  const ms = o.durationMs ?? o.duration_ms;
  if (typeof ms === "number" && Number.isFinite(ms)) return ms;
  if (typeof ms === "string" && ms.trim()) {
    const n = Number(ms);
    return Number.isFinite(n) ? n : null;
  }
  const d = o.duration;
  if (typeof d === "number" && Number.isFinite(d)) return d < 1e6 ? d * 1000 : d;
  return null;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}m ${rs}s`;
}

function normalizeFailedDifyDocuments(value: unknown): FailedDifyDocument[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return {
        filePath: typeof o.filePath === "string" ? o.filePath : typeof o.name === "string" ? o.name : undefined,
        difyDocId:
          typeof o.difyDocId === "string"
            ? o.difyDocId
            : typeof o.docId === "string"
              ? o.docId
              : typeof o.documentId === "string"
                ? o.documentId
                : undefined,
        batchId: typeof o.batchId === "string" ? o.batchId : undefined,
        indexingStatus:
          typeof o.indexingStatus === "string"
            ? o.indexingStatus
            : typeof o.indexing_status === "string"
              ? o.indexing_status
              : undefined,
        error: typeof o.error === "string" ? o.error : typeof o.errorMessage === "string" ? o.errorMessage : undefined,
        retryable: typeof o.retryable === "boolean" ? o.retryable : undefined
      };
    })
    .filter((doc) => doc.filePath || doc.difyDocId || doc.batchId || doc.error);
}

export function normalizeSyncSteps(stepsJson: unknown): NormalizedSyncStep[] {
  if (!Array.isArray(stepsJson)) return [];
  return stepsJson.map((raw, i) => {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const logStepName = String(o.stepName ?? o.task ?? o.name ?? o.step ?? `Step ${i + 1}`);
    const task = String(o.task ?? o.stepName ?? o.name ?? o.step ?? `Step ${i + 1}`);
    const status = String(o.stepStatus ?? o.status ?? "pending").toLowerCase();
    const startedAt =
      typeof o.startedAt === "string"
        ? o.startedAt
        : typeof o.started === "string"
          ? o.started
          : typeof o.timestamp === "string"
            ? o.timestamp
            : null;
    const err =
      typeof o.errorMessage === "string"
        ? o.errorMessage
        : typeof o.error === "string"
          ? o.error
          : null;
    const id = typeof o.id === "string" ? o.id : `${i}-${task}`;
    return {
      key: id,
      task,
      logStepName,
      status,
      startedAt,
      durationLabel: formatDuration(pickDurationMs(o)),
      errorMessage: err,
      failedDocuments: normalizeFailedDifyDocuments(o.failedDocuments)
    };
  });
}

export function hasFailedDifyIndexing(job: SyncJob | null | undefined): boolean {
  if (!job || String(job.status).toLowerCase() !== "failed") return false;
  return normalizeSyncSteps(job.stepsJson).some((step) => isFailedDifyIndexingStep(step));
}

export function isFailedDifyIndexingStep(step: NormalizedSyncStep): boolean {
  return (
    (step.logStepName === "dify_indexing" || step.logStepName === "retry_failed_indexing") &&
    (step.status === "failed" || step.errorMessage != null || step.failedDocuments.length > 0)
  );
}

export function stepBadgeVariant(status: string): "pending" | "running" | "completed" | "failed" {
  const s = status.toLowerCase();
  if (s === "failed" || s === "error") return "failed";
  if (s === "completed" || s === "success" || s === "done") return "completed";
  if (s === "running" || s === "in_progress" || s === "in progress") return "running";
  return "pending";
}

export function stepStatusEmoji(status: string): string {
  const v = stepBadgeVariant(status);
  if (v === "failed") return "❌";
  if (v === "completed") return "✅";
  if (v === "running") return "🔄";
  return "⏳";
}
