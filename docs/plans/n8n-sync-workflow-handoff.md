# n8n Sync Workflow — Handoff Document
**Date:** 2026-04-23  
**Status:** In Progress — workflow logic bugs identified through file upload stage; latest blocker is n8n startup hang after publishing newest workflow version

---

## What We're Building

A platform that syncs GitHub/GitLab repos into Dify knowledge bases using an n8n workflow. The sync is triggered via webhook, and progress is tracked in a `RagKbSyncJob` DB record and reported step-by-step to a frontend "Sync Process Monitor".

---

## The Core Problem

The n8n GitHub sync workflow (`4f8dbb73-d6c5-4a55-8178-8c4f51c76d01`) was rebuilt to a new 14-node flow but **keeps failing before it can process any files**. Each execution ends in `error` within ~1 second.

---

## What Was Fixed So Far

### 1. n8n uses `workflow_history` table — not `workflow_entity.nodes`
n8n reads the active workflow from `workflow_history` via `activeVersionId`. Simply updating `workflow_entity.nodes` via SQL does nothing at runtime. 

**Fix:** Insert a new row into `workflow_history` and update `workflow_entity.activeVersionId` to point to it. History entries cannot be updated in-place (immutable — updates silently no-op). New versionIds used:
- GitHub: `b1c2d3e4-f5a6-7890-abcd-ef1234567890`
- GitLab: `d4e5f6a7-b8c9-0123-defa-bc4567890123`

**Pattern for any future node change:**
```sql
-- 1. Insert new history entry
INSERT INTO workflow_history ("versionId", "workflowId", "authors", "nodes", "connections", "name", "autosaved")
SELECT '<new-uuid>', '<workflow-id>', 'admin', nodes, connections, name, false
FROM workflow_entity WHERE id = '<workflow-id>';

-- 2. Point workflow_entity to new version
UPDATE workflow_entity
SET "activeVersionId" = '<new-uuid>', "versionId" = '<new-uuid>', "updatedAt" = NOW()
WHERE id = '<workflow-id>';
```
Then: `docker compose stop n8n && docker compose rm -f n8n && docker compose up -d n8n`

### 2. Connections referenced old node names
The `connections` JSON in `workflow_history` pointed to old names ("Filter Markdown Files", "Respond to Webhook" etc.). Fixed to reference all 14 new node names in the correct linear order.

### 3. `N8N_PATH=/n8n/` added to docker-compose
Added so n8n editor works at `https://dev.eclassmanager.com/n8n/`. The webhooks stay at `/webhook/...` (not sub-pathed). Internal webhook URL `http://n8n:5678/webhook/rag-sync-github` is correct.

### 4. Empty `Authorization: token ` header causing GitHub 401
When the KB has no GitHub token configured (public repo), the node sends `Authorization: token ` (with empty value). GitHub rejects this with 401, which n8n reports as "Not Found".

**Fix applied:** Updated `Get Repo File Tree` and `Fetch File Content` node parameters to use conditional expressions:
- Header name: `={{ $json.sourceToken ? 'Authorization' : 'X-Placeholder' }}`
- Header value: `={{ $json.sourceToken ? 'token ' + $json.sourceToken : 'none' }}`

---

## Current State (as of 2026-04-23 18:35 UTC)

- Execution #24 failed in `Get Repo File Tree` with:
  - `Header name must be a valid HTTP token ["=x-placeholder"]`
- Root cause: the conditional header expressions were saved as `=={{ ... }}` instead of `={{ ... }}` in both GitHub HTTP nodes.
- Fix applied live:
  - GitHub workflow version `c42a9335-860c-42f6-9e19-1d7e93b195e8` corrected the extra `=`
  - repo template `infra/n8n/templates/github-to-dify-sync.json` was also updated to match

- Execution #25 then failed in `Get Repo File Tree` with:
  - GitHub URL rendered as `https://api.github.com/repos///git/trees/?recursive=1`
- Root cause: `Init Step Callback` returned only `{ updated: true }`, so downstream nodes lost `owner/repo/branch`. The same data-loss pattern also affected `Upload Start Callback`, `Report File Progress`, `Indexing Start Callback`, `Dify Indexing Start Callback`, and `Report Final Status`.
- Fix applied live:
  - workflow version `f561f06d-384d-4942-83d2-608f96931de7`
  - callback nodes were converted into pass-through code nodes so they report progress and return the original items unchanged
  - `Filter Supported Files` now also includes `fileIndex`

- Execution #26 completed without n8n node errors, but all 18 uploads failed logically:
  - `Upload Doc to Dify` error: `Cannot read properties of undefined (reading 'split')`
- Root cause: `Fetch File Content` returned only the GitHub blob response, so `filePath` / `fileExt` were no longer available to the upload node.
- Fix prepared live:
  - workflow version `217e93ef-3869-4065-8507-dedab043bed8`
  - `Fetch File Content` switched to GitHub contents API raw file download with HTTP `responseFormat=file`
  - `Upload Doc to Dify` updated to read binary payload from `item.binary.fileData`

- **Current blocker**
  - After publishing version `217e93ef-3869-4065-8507-dedab043bed8`, `docker compose up -d n8n` leaves the container process running but it does not bind `127.0.0.1:5678`
  - Inside container: `wget http://127.0.0.1:5678/healthz` returns connection refused
  - Process table shows n8n main process in `D` state at least once during restart attempts
  - This needs to be resolved before execution #27+ can be re-tested against the new fetch/upload changes

---

## How to Debug

### Confirm latest live GitHub workflow version
```bash
docker exec 09_automationplatform-n8n-db-1 psql -U n8n -d n8n -c \
  "SELECT \"activeVersionId\", \"versionId\", \"updatedAt\" FROM workflow_entity WHERE id = '4f8dbb73-d6c5-4a55-8178-8c4f51c76d01';"
```

Expected newest version after the latest edits:
- `217e93ef-3869-4065-8507-dedab043bed8`

### Read the latest execution error
```bash
EXEC_ID=$(docker exec 09_automationplatform-n8n-db-1 psql -U n8n -d n8n -t -c \
  "SELECT id FROM execution_entity ORDER BY \"startedAt\" DESC LIMIT 1;" | tr -d ' \n')

docker exec 09_automationplatform-n8n-db-1 psql -U n8n -d n8n -t -c \
  "SELECT data FROM execution_data WHERE \"executionId\" = $EXEC_ID;" | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
data = json.loads(raw)

def deref(val, lookup):
    if isinstance(val, str) and val.lstrip('-').isdigit():
        idx = int(val)
        if 0 <= idx < len(lookup):
            return deref(lookup[idx], lookup)
    if isinstance(val, dict):
        return {k: deref(v, lookup) for k, v in val.items()}
    if isinstance(val, list):
        return [deref(i, lookup) for i in val]
    return val

resolved = deref(data[0], data)
rd = resolved.get('resultData', {}).get('runData', {})
print('Last node:', resolved.get('resultData', {}).get('lastNodeExecuted'))
for node, runs in rd.items():
    for run in runs:
        err = run.get('error')
        if err:
            print(f'ERROR [{node}]:', err.get('message',''), err.get('description',''))
        else:
            cnt = len((run.get('data',{}).get('main',[[]])[0]) or [])
            print(f'OK [{node}]: {cnt} items')
"
```

### Inspect the specific runtime failures already seen
```bash
# #24 malformed header expression
EXEC_ID=24

# #25 callback node dropped owner/repo/branch
EXEC_ID=25

# #26 fetch-content node dropped file metadata before upload
EXEC_ID=26
```

### Trigger a fresh test run
```bash
TOKEN="0a4e28221f3b67506644d40b023b12c9a0a367061accd66d38033307e9cf05a8"
DIFY_KEY="dataset-9fT7yHhX5Q5f3ImtBmJzqFRF"
SYNC_JOB_ID="test-$(date +%s)"

docker exec 09_automationplatform-postgres-1 psql -U platform -d automation -c "
INSERT INTO \"RagKbSyncJob\" (id, \"knowledgeBaseId\", trigger, status, \"filesProcessed\", \"chunksProcessed\", \"createdAt\")
VALUES ('$SYNC_JOB_ID', 'cmoaho7ye00002qaxm0n32tqq', 'manual', 'running', 0, 0, NOW());"

curl -s -X POST "http://localhost:5679/webhook/rag-sync-github" \
  -H "Content-Type: application/json" \
  -d "{
    \"kbId\": \"cmoaho7ye00002qaxm0n32tqq\",
    \"syncJobId\": \"$SYNC_JOB_ID\",
    \"sourceUrl\": \"https://github.com/appleidbalihar/automation\",
    \"sourceBranch\": \"master\",
    \"sourcePath\": \"docs/operations\",
    \"sourceType\": \"github\",
    \"difyDatasetId\": \"a3547e70-aab0-4d3a-934f-af4bec344a14\",
    \"difyApiUrl\": \"http://dify-api:5001\",
    \"difyApiKey\": \"$DIFY_KEY\",
    \"progressCallbackUrl\": \"https://api-gateway:4000/rag/knowledge-bases/cmoaho7ye00002qaxm0n32tqq/sync-progress\",
    \"progressCallbackToken\": \"$TOKEN\"
  }"
```

### After fixing any node — update workflow_history and restart
```bash
# Step 1: Update workflow_entity.nodes with corrected node JSON (via SQL)

# Step 2: Sync to workflow_history (insert new row — updates don't work)
docker exec 09_automationplatform-n8n-db-1 psql -U n8n -d n8n -c "
INSERT INTO workflow_history (\"versionId\", \"workflowId\", \"authors\", \"nodes\", \"connections\", \"name\", \"autosaved\")
SELECT '<new-uuid>', '4f8dbb73-d6c5-4a55-8178-8c4f51c76d01', 'admin', nodes, connections, name, false
FROM workflow_entity WHERE id = '4f8dbb73-d6c5-4a55-8178-8c4f51c76d01';

UPDATE workflow_entity
SET \"activeVersionId\" = '<new-uuid>', \"versionId\" = '<new-uuid>', \"updatedAt\" = NOW()
WHERE id = '4f8dbb73-d6c5-4a55-8178-8c4f51c76d01';"

# Step 3: Full container restart (simple restart is not reliable)
docker compose stop n8n && docker compose rm -f n8n && docker compose up -d n8n
```

### Verify n8n loaded the correct workflow version
After restart, confirm the activated workflow uses the expected versionId:
```bash
docker exec 09_automationplatform-n8n-db-1 psql -U n8n -d n8n -c \
  "SELECT \"activeVersionId\", \"versionId\", \"updatedAt\" FROM workflow_entity WHERE id = '4f8dbb73-d6c5-4a55-8178-8c4f51c76d01';"
```

---

## Key System Details

| Item | Value |
|------|-------|
| KB ID | `cmoaho7ye00002qaxm0n32tqq` |
| KB name | `git` (platform-admin) |
| GitHub repo | `https://github.com/appleidbalihar/automation` |
| Branch / Path | `master` / `docs/operations` |
| GitHub workflow n8n ID | `4f8dbb73-d6c5-4a55-8178-8c4f51c76d01` |
| GitLab workflow n8n ID | `22d3d7b8-d94b-4300-a3a3-b55835e6c902` |
| Active history versionId (GitHub) | `217e93ef-3869-4065-8507-dedab043bed8` |
| Active history versionId (GitLab) | `d4e5f6a7-b8c9-0123-defa-bc4567890123` |
| Dify dataset ID | `a3547e70-aab0-4d3a-934f-af4bec344a14` |
| Dify API key | `dataset-9fT7yHhX5Q5f3ImtBmJzqFRF` |
| n8n webhook token | `0a4e28221f3b67506644d40b023b12c9a0a367061accd66d38033307e9cf05a8` |
| n8n internal URL | `http://n8n:5678` (container-to-container) |
| n8n host URL | `http://localhost:5679` (from host) |
| n8n editor URL | `https://dev.eclassmanager.com/n8n/` |
| n8n DB container | `09_automationplatform-n8n-db-1` user `n8n` db `n8n` |
| Platform DB container | `09_automationplatform-postgres-1` user `platform` db `automation` |
| Progress callback URL | `https://api-gateway:4000/rag/knowledge-bases/{kbId}/sync-progress` |
| Progress callback auth | Header `X-Rag-Sync-Token: {token}` |

---

## The 14-Node Workflow (Intended Flow)

```
1.  Webhook Trigger           — responseMode: onReceived (responds immediately, async from here)
2.  Parse Sync Params         — Code: extracts owner/repo from sourceUrl, adds syncStartedAt
3.  Init Step Callback        — HTTP, executeOnce: true — reports fetch_file_tree: running
4.  Get Repo File Tree        — HTTP: GET github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1
5.  Filter Supported Files    — Code: filters 16 extensions (md, txt, pdf, docx, xlsx, etc.), outputs fileSha
6.  Upload Start Callback     — HTTP, executeOnce: true — reports fetch_file_tree: completed, upload_files: running
7.  Fetch File Content        — HTTP: GET github.com/repos/{owner}/{repo}/git/blobs/{fileSha} (base64)
8.  Upload Doc to Dify        — Code: text→create_by_text, binary→create_by_file multipart
9.  Report File Progress      — HTTP per file: filesProcessed=$itemIndex+1
10. Aggregate Doc IDs         — Code: collects all difyDocIds → 1 item
11. Indexing Start Callback   — HTTP: reports upload_files: completed
12. Dify Indexing Start Callback — HTTP: reports dify_indexing: running
13. Poll Dify Indexing        — Code: polls every 5s, max 24 attempts (2min), returns finalStatus
14. Report Final Status       — HTTP: status=completed or failed, dify_indexing step done
```

### Supported File Extensions (16 total)
- **Text** (→ `create_by_text`): `.md` `.markdown` `.txt` `.html` `.htm` `.xml` `.csv`
- **Binary** (→ `create_by_file` multipart): `.pdf` `.docx` `.xlsx` `.xls` `.pptx` `.ppt` `.eml` `.msg` `.epub`

### Progress Callback Body Structure
```json
{
  "syncJobId": "...",
  "status": "running | completed | failed",
  "filesProcessed": 0,
  "filesTotal": 18,
  "chunksProcessed": 0,
  "step": {
    "task": "Fetch File Tree",
    "stepName": "fetch_file_tree | upload_files | dify_indexing",
    "status": "running | completed | failed",
    "startedAt": "ISO8601",
    "completedAt": "ISO8601",
    "message": "human readable",
    "errorMessage": ""
  },
  "logMessage": "log text for OpenSearch",
  "logSeverity": "INFO | ERROR"
}
```

---

## Known n8n Gotchas

1. **`workflow_history` is immutable** — you cannot UPDATE nodes/connections in an existing history row. Always INSERT a new row with a new UUID, then point `activeVersionId` to it.

2. **Full container restart required** — `docker compose restart n8n` is not reliable. Always use `stop → rm -f → up`.

3. **`$itemIndex` not `$runIndex`** — `$runIndex` is always 0 in linear flows. Use `$itemIndex + 1` for per-file counters.

4. **`executeOnce: true`** — Required on HTTP Request nodes that should fire only once when receiving N items (e.g., Init Step Callback, Upload Start Callback).

5. **Empty Authorization header breaks GitHub API** — Sending `Authorization: token ` (empty token) returns 401 even for public repos. Use conditional expressions to skip the header when no token.

6. **Dify `max_tokens` limit** — Must be 50–1000 for `create_by_text`. Value of 1800 causes all docs to error silently.

7. **Dify indexing is async** — Upload returns 200 immediately, but indexing takes 30s–2min. Must poll `GET /v1/datasets/{id}/documents/{docId}/indexing-status`.
