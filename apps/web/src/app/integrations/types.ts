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

export type Integration = {
  id: string;
  name: string;
  description: string | null;
  sourceType: string;
  sourceUrl: string;
  sourceBranch: string | null;
  sourcePath: string | null;
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
  description: string;
  sourceType: "github" | "gitlab" | "googledrive" | "web";
  sourceUrl: string;
  sourceBranch: string;
  sourcePath: string;
  githubToken: string;
  gitlabToken: string;
  googleDriveAccessToken: string;
  googleDriveRefreshToken: string;
  setDefault: boolean;
};

export const EMPTY_FORM: IntegrationForm = {
  name: "",
  description: "",
  sourceType: "github",
  sourceUrl: "",
  sourceBranch: "main",
  sourcePath: "docs/",
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
    return {
      sourceType: "gitlab",
      sourceUrl: gitlabTreeMatch[1],
      sourceBranch: gitlabTreeMatch[2] || current.sourceBranch,
      sourcePath: gitlabTreeMatch[3] || current.sourcePath
    };
  }

  const githubTreeMatch = trimmed.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)\/?(.*)$/i);
  if (githubTreeMatch) {
    return {
      sourceType: "github",
      sourceUrl: githubTreeMatch[1],
      sourceBranch: githubTreeMatch[2] || current.sourceBranch,
      sourcePath: githubTreeMatch[3] || current.sourcePath
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
      errorMessage: err
    };
  });
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
