# RAG Knowledge Base Sync - Developer Reference

## Source Files

| Area | Files |
|------|-------|
| Gateway routes/auth | `apps/api-gateway/src/main.ts` |
| Sync orchestration | `apps/workflow-service/src/main.ts` |
| UI source management | `apps/web/src/app/integrations-page.tsx` and `apps/web/src/app/integrations/*` |
| Prisma models | `packages/db/prisma/schema.prisma` |
| n8n templates | `infra/n8n/templates/source-to-dify-sync.json` (unified), legacy: `github-to-dify-sync.json`, `gitlab-to-dify-sync.json` |

## Important Routes

### Browser-facing routes through api-gateway

| Method | Path | Roles |
|--------|------|-------|
| `GET` | `/rag/integrations` | authenticated platform roles |
| `POST` | `/rag/integrations` | authenticated platform roles |
| `PATCH` | `/rag/integrations/:id` | authenticated platform roles |
| `PATCH` | `/rag/integrations/:id/oauth-app-credentials` | `admin`, `useradmin`, `operator` |
| `DELETE` | `/rag/integrations/:id` | authenticated platform roles |
| `POST` | `/rag/integrations/:id/set-default` | authenticated platform roles |
| `GET` | `/rag/knowledge-bases` | authenticated platform roles |
| `POST` | `/rag/knowledge-bases` | `admin`, `useradmin` |
| `GET` | `/rag/knowledge-bases/:id` | authenticated platform roles |
| `PATCH` | `/rag/knowledge-bases/:id/config` | authenticated platform roles |
| `GET` | `/rag/knowledge-bases/default-prompt` | `admin`, `useradmin` |
| `POST` | `/rag/knowledge-bases/:id/generate-prompt` | `admin`, `useradmin` |
| `POST` | `/rag/knowledge-bases/:id/apply-template` | `admin`, `useradmin` |
| `POST` | `/rag/knowledge-bases/:id/shares` | authenticated platform roles |
| `GET` | `/rag/knowledge-bases/:id/shares` | authenticated platform roles |
| `DELETE` | `/rag/knowledge-bases/:id/shares/:shareId` | authenticated platform roles |
| `POST` | `/rag/knowledge-bases/:id/sync` | `admin`, `useradmin`, `operator` |
| `POST` | `/rag/knowledge-bases/:id/sync-cancel` | `admin`, `useradmin`, `operator` |
| `POST` | `/rag/knowledge-bases/:id/retry-failed-indexing` | `admin`, `useradmin`, `operator` |
| `POST` | `/rag/knowledge-bases/:id/cleanup` | `admin`, `useradmin`, `operator` |
| `GET` | `/rag/knowledge-bases/:id/sync-status` | authenticated platform roles |
| `GET` | `/rag/knowledge-bases/:id/sync-history` | `admin`, `useradmin`, `operator` |
| `GET` | `/logs/sync-job` | `admin`, `useradmin`, `operator` |

### Prompt template routes through api-gateway

| Method | Path | Roles |
|--------|------|-------|
| `GET` | `/rag/prompt-templates` | `admin`, `useradmin` |
| `POST` | `/rag/prompt-templates` | `admin`, `useradmin` |
| `GET` | `/rag/prompt-templates/:id` | `admin`, `useradmin` |
| `PATCH` | `/rag/prompt-templates/:id` | `admin`, `useradmin` |
| `DELETE` | `/rag/prompt-templates/:id` | `admin`, `useradmin` |
| `POST` | `/rag/prompt-templates/:id/duplicate` | `admin`, `useradmin` |
| `POST` | `/rag/prompt-templates/:id/share` | `admin`, `useradmin` |
| `DELETE` | `/rag/prompt-templates/:id/share/:userId` | `admin`, `useradmin` |
| `POST` | `/rag/prompt-templates/generate` | `admin`, `useradmin` |

### n8n/internal callback routes

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/rag/knowledge-bases/:id/sync-diff` | `X-Rag-Sync-Token` or `X-N8N-Webhook-Token` |
| `POST` | `/rag/knowledge-bases/:id/sync-progress` | `X-Rag-Sync-Token` or `X-N8N-Webhook-Token` |
| `POST` | `/rag/sync-error-handler` | internal n8n error flow |

## Current Sync Diff

The implementation is `POST /rag/knowledge-bases/:id/sync-diff` in workflow-service.

Input shape:

```json
{
  "syncJobId": "job-id",
  "tree": [
    { "path": "docs/runbook.md", "type": "blob", "sha": "abc123" }
  ]
}
```

Output shape:

```json
{
  "ok": true,
  "files": [
    {
      "path": "docs/runbook.md",
      "sha": "abc123",
      "isUpdate": false
    }
  ]
}
```

For modified files, the returned item can include `difyDocumentId` and `isUpdate: true`.

The diff logic uses:

- `RagKnowledgeBase.sourcePaths` for configured path filters.
- legacy `RagKnowledgeBase.sourcePath` only as a fallback.
- `RagKbFileTracker` for prior `filePath`, `fileSha`, and `difyDocumentId`.

Do not use `RagKbSourcePath`; it is an old table name.

## File Tracker Updates

`sync-progress` updates `RagKbFileTracker` when it receives:

```json
{
  "status": "running",
  "step": {
    "stepName": "upload_file_success",
    "status": "completed"
  },
  "filePath": "docs/runbook.md",
  "fileSha": "abc123",
  "difyDocumentId": "dify-doc-id"
}
```

The service upserts by `(knowledgeBaseId, filePath)`.

## Step JSON

`RagKbSyncJob.stepsJson` is stored as an array. The helper updates the entry with the same `stepName` if present, otherwise it appends a new step.

Common step object:

```json
{
  "task": "Upload Files",
  "stepName": "upload_files",
  "status": "running",
  "startedAt": "2026-05-04T12:00:00.000Z",
  "message": "3/8 processed",
  "errorMessage": null
}
```

`dify_indexing` and `retry_failed_indexing` may include `failedDocuments`.

## Job Statuses

Expected values include:

- `pending`
- `running`
- `completed`
- `failed`
- `timed_out`
- `cancelled`

`lastProgressAt` is refreshed on callbacks and used for stale-job sweeping.

## UI Integration

Current primary routes:

- `/knowledge-connector`: source and sync management.
- `/rag-assistant`: Dify-backed chat.
- `/ai-agent-prompt`: reusable system prompt template management for admin/useradmin.

Compatibility routes:

- `/integrations`: same component as Knowledge Connector.
- `/operations-ai`, `/operations-ai-dify`, `/operations-ai/setup`: redirects.

Important UI files:

- `CreateSourceModal.tsx`: OAuth/PAT create flow and provider setup instructions.
- `EditSourceModal.tsx`: metadata/path/token/OAuth updates.
- `KnowledgeSourcesTable.tsx`: row actions including sync, cleanup, share, edit, delete.
- `SyncProcessMonitor.tsx`: job polling, step table, retry actions.
- `StepLogDrawer.tsx`: `/logs/sync-job` drawer.
- `prompt-templates/*`: template list, cards, editor modal, and API client.

## Prompt Templates

Prompt templates are stored in `SystemPromptTemplate` and `SystemPromptTemplateShare`. Built-in templates are seeded by workflow-service startup logic, private templates belong to `ownerId`, and shared templates use either `shareScope = "all"` or rows in `SystemPromptTemplateShare`.

Applying a template:

```text
POST /rag/knowledge-bases/:id/apply-template { "templateId": "..." }
```

The workflow-service checks visibility, updates `RagKnowledgeBase.templateId`, writes prompt-related KB config fields, and pushes the prompt to Dify when a Dify app is available.

## Cleanup

Full cleanup endpoint:

```text
POST /rag/knowledge-bases/:id/cleanup
```

It cancels any running sync, deletes indexed Dify documents where possible, clears tracker rows, resets KB sync state, and writes a cleanup sync job so the monitor/history can show what happened.

## Retry Failed Indexing

Retry endpoint:

```text
POST /rag/knowledge-bases/:id/retry-failed-indexing
```

Request body may include a `syncJobId` and/or `documentIds`. The workflow-service creates a retry job with `trigger: "retry_failed_indexing"` and step name `retry_failed_indexing`.

## n8n Template Updates

When you make changes to the n8n sync workflows (e.g. adding new nodes or modifying logic), there are specific steps to perform to ensure the changes are picked up by the platform.

All source types (GitHub, GitLab, Google Drive) route through one unified workflow:

```text
infra/n8n/templates/source-to-dify-sync.json   ← the only active template
```

### Method 1: Automatic Import via Restart (Recommended)

`infra/n8n/init-workflows.sh` imports and activates the `source-to-dify-sync.json` file automatically on every container start (mounted via `docker-compose.yml`).

To apply a template change automatically, edit the JSON and restart n8n using the platform script (do not use plain `docker compose restart`):

```bash
# For development:
scripts/platform-containers.sh dev restart n8n

# For production:
scripts/platform-containers.sh prod restart n8n
```

### Method 2: Manual Import via UI/CLI

If you prefer to manually import the workflow into n8n for testing or rapid iteration:
1. Open the n8n UI.
2. Go to your workflows and select "Import from File" or use the n8n CLI `n8n import:workflow`.
3. Once imported and tested, **ensure you export the final JSON** back to `infra/n8n/templates/source-to-dify-sync.json` so the changes are saved to version control.

### Typical Developer Commands

For AI agents and developers, when modifying the platform codebase or workflows, use the following commands depending on what was changed:

**Rebuilding Services:**
When modifying `apps/workflow-service` or `apps/web` (or similar code), you need to rebuild the containers:
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml build workflow-service web 2>&1
```

**Restarting Services:**
Always use the `platform-containers.sh` script to restart containers so the Vault agents and correct profiles are handled:
```bash
scripts/platform-containers.sh dev restart n8n workflow-service
```

Active workflow:

| Workflow | Webhook path | ID |
|----------|--------------|----|
| Generic Source to Dify Sync | `POST /webhook/rag-sync-source` | `rag-sync-source-template` |

Legacy workflows (inactive):

| Workflow | ID |
|----------|----|
| GitHub → Dify KB Sync | `c81ad5e4-7f92-4e07-a2d3-741534a0c16c` |
| GitLab → Dify KB Sync | `22d3d7b8-d94b-4300-a3a3-b55835e6c902` |

## Output Gating

Output gating is a deterministic code-level enforcement layer that runs on **both** the user's incoming question (before Dify) and the LLM's response (before returning to the user). It is the non-negotiable security layer — unlike system prompt rules, it cannot be bypassed by retrieved document content.

### Tiers

| Tier | Configurable? | Examples |
|------|--------------|---------|
| Always-on | No — hardcoded | Passwords, API keys, credit cards, SSN, IBAN, JWT, PEM private keys, passport/licence numbers, medical IDs, routing numbers, security question answers |
| Optional | Per-KB checkbox (default off) | Email addresses, phone numbers |
| Custom | Per-KB user-defined regex | Any pattern with label + enable/disable toggle |

### `outputGatingConfig` JSON shape

Stored in `RagKnowledgeBaseConfig.outputGatingConfig` (JSONB):

```typescript
{
  emailGating?: boolean;       // default: false — enable to block emails from responses
  phoneGating?: boolean;       // default: false — enable to block phone numbers
  customPatterns?: Array<{
    id: string;                // uuid for UI keying
    label: string;             // shown in redacted output e.g. "[Employee ID REDACTED]"
    pattern: string;           // regex string (validated before save)
    enabled: boolean;
  }>;
}
```

### Key functions — `apps/workflow-service/src/main.ts`

| Function | Description |
|----------|-------------|
| `validateUserInput(query, kbId, gatingConfig?)` | Runs before Dify. Blocks if the user's question contains a sensitive value (e.g. typed SSN, pasted JWT). Returns `{ blocked, flags }`. |
| `validateLlmOutput(answer, kbId, context, gatingConfig?)` | Runs after Dify AND after fallback synthesis. Redacts always-on + optional + custom patterns. Returns `{ safe, sanitized, flags }`. |
| `_SECRET_PATTERNS` | Structural always-on regex (API tokens, credit cards, SSN, IBAN, JWT, PEM key headers). |
| `_CONTEXTUAL_CREDENTIAL_PATTERNS` | Contextual always-on patterns (passwords in all formats, SSN labels, passport labels, medical IDs, routing numbers, security answers). |
| `_OPTIONAL_GATE_PATTERNS` | Per-KB configurable patterns (`emailGating`, `phoneGating`). |

### Password credential patterns (`_CONTEXTUAL_CREDENTIAL_PATTERNS`)

The following formats are all caught by the always-on password patterns. The lookahead `(?=[^\s]*[@!#$%^&*\d])` requires the credential value to contain at least one digit or special character, which prevents false positives on plain English words.

| Format | Example |
|--------|---------|
| Direct colon/equals | `password: Goldy@12` |
| Bold markdown (Dify default) | `password: **Goldy@12**` |
| Multiline bold | `password:\n\n**Goldy@12**` |
| Multiline plain | `password:\n\nGoldy@12` |
| "is" connector | `the default password is Goldy@12` |
| "is:" connector | `the default password is: Goldy@12` |
| "was set to" | `password was set to Goldy@12` |
| "is now" | `password is now Goldy@12` |
| "has been reset to" | `the password has been reset to Goldy@12` |
| "configured as" | `password configured as Goldy@12` |
| Slash-separated credentials | `credentials: admin / MyPass123` |
| Backtick code format | `password is \`Goldy@12\`` |

**Important implementation note:** The patterns use the `gi` (global, case-insensitive) flag. The `i` flag makes `[A-Z]` match lowercase letters, so lookaheads that use `[A-Z@!#$%^&*\d]` behave as if case-insensitive. Always use `(?=[^\s]*[@!#$%^&*\d])` (special/digit requirement unaffected by `i` flag) rather than `[A-Z@!#$%^&*\d]` for the credential value lookahead — otherwise plain English words like "valid" or "available" will trigger false positives.

### Fallback synthesis gating

Both the Slack and GUI handlers use a `synthesizeFromChunks` fallback when either output gating or the hallucination guard rejects the primary Dify answer. This fallback makes a second LLM call using the raw KB chunks, which may themselves contain credentials.

`validateLlmOutput` is called on the fallback/synthesized answer as well as the primary Dify answer. This ensures credentials cannot leak through the fallback path.

```typescript
// Slack handler (same pattern in GUI handler)
const slackRaw = slackSynthesized ?? `Based on retrieved documents:\n\n...`;
const slackFallbackGate = validateLlmOutput(slackRaw, mapping.knowledgeBaseId, {}, slackKbGatingConfig);
slackFinalAnswer = slackFallbackGate.sanitized;
```

### Adding a new always-on pattern

1. If the pattern has a reliable structural format (e.g. a new token prefix), add a `RegExp` to `_SECRET_PATTERNS`.
2. If the pattern requires a label prefix (e.g. "passport: X"), add an entry to `_CONTEXTUAL_CREDENTIAL_PATTERNS` with `pattern` and `replacer`.
3. Use `(?=[^\s]*[@!#$%^&*\d])` as the credential value lookahead — do NOT use `[A-Z@!#$%^&*\d]` due to the `i` flag making it case-insensitive.
4. Invalid customer regex in `customPatterns` is silently skipped and logged to `PlatformLog` with message `custom_gate_invalid_regex`.

### System prompt flow

The platform no longer force-appends a hidden Layer 3 to every KB system prompt. The customer's configured prompt is sent to Dify exactly as saved. Generated prompts embed `ABSOLUTE_SECURITY_RULE` and `ADVISORY_PRIVACY_RULE` as visible, editable sections — customers can modify or remove them. Security enforcement is code-level (output gating), not prompt-level.

## Development Checks

Useful commands:

```bash
pnpm --filter workflow-service test
pnpm --filter web build
pnpm --filter api-gateway build
docker compose logs workflow-service --since 30m
docker compose logs n8n --since 30m
```
