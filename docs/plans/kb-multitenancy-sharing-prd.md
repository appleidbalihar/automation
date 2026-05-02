# PRD: Knowledge Base Multi-Tenancy, Sharing & Dify Key Auto-Recovery

**Version:** 1.0  
**Date:** 2026-05-01  
**Author:** Platform Engineering  
**Status:** Approved for Implementation

---

## 1. Overview & Goals

### Problem Statement

The current KB system has two fundamental issues:

1. **No true ownership model**: Knowledge Bases use a `scope: "global"` flag that makes them visible to all users. There is no way to create a truly private KB or share selectively.
2. **Dify API key fragility**: When the `dify-api`/`dify-worker` container restarts with a reset DB, all API keys stored in Vault become stale (401). Recovery requires manual intervention.

### Goals

1. Replace global-scope KBs with a fully owned model where every KB belongs to a specific user.
2. Allow KB owners (or platform admins) to share a KB with specific users by their username.
3. Support querying multiple selected KBs simultaneously with labeled per-KB responses.
4. Guarantee complete chat session isolation — no user can see another user's conversation history.
5. Auto-recover from Dify API key invalidation without operator involvement.

---

## 2. User Roles

| Role | Capabilities |
|---|---|
| `platform-admin` (role: `admin`) | Create KBs, see all KBs, share any KB, delete any KB, sync any KB |
| `useradmin` | Create KBs, see own KBs + KBs shared with them, share own KBs |
| Any auth user | Create KBs, see own KBs + shared KBs, chat against accessible KBs |

---

## 3. Data Model Changes

### 3.1 RagKnowledgeBase (modified)

```prisma
model RagKnowledgeBase {
  id            String   @id @default(cuid())
  name          String
  description   String?

  sourceType    String
  sourceUrl     String
  sourceBranch  String?
  sourcePath    String?
  syncSchedule  String?

  difyAppUrl    String   @default("http://dify-api:5001")
  difyDatasetId String?

  // REMOVED: scope String @default("global")
  // CHANGED: ownerId is now required (never null)
  ownerId       String        // Keycloak preferred_username of the creator
  ownerUsername String        // Display name (same as ownerId for now, kept separate for future)
  isDefault     Boolean  @default(false)
  createdById   String        // Same as ownerId at creation time

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  threads       RagDiscussionThread[]
  config        RagKnowledgeBaseConfig?
  syncJobs      RagKbSyncJob[]
  deployments   RagChannelDeployment[]
  shares        RagKbShare[]           // NEW: who this KB is shared with

  @@index([ownerId])
  @@index([isDefault])
  @@index([createdById])
}
```

### 3.2 RagKbShare (NEW table)

```prisma
// Tracks which users a KB owner has shared their KB with.
// Only the owner or a platform admin can create or revoke shares.
// Shared users get "chat" access: they can query the KB but cannot
// edit, delete, or sync it.
model RagKbShare {
  id                String           @id @default(cuid())
  knowledgeBaseId   String
  knowledgeBase     RagKnowledgeBase @relation(fields: [knowledgeBaseId], references: [id], onDelete: Cascade)

  sharedWithId      String           // Keycloak preferred_username of recipient
  sharedById        String           // Keycloak preferred_username of granter (owner or admin)
  permission        String           @default("chat")  // "chat" — extensible

  createdAt         DateTime         @default(now())

  @@unique([knowledgeBaseId, sharedWithId])  // one share record per user per KB
  @@index([sharedWithId])
  @@index([knowledgeBaseId])
}
```

### 3.3 RagDiscussionThread (modified)

```prisma
model RagDiscussionThread {
  id                 String   @id @default(cuid())
  ownerId            String   // strict: only this user sees this thread

  // Single-KB legacy field kept for backward compat
  knowledgeBaseId    String?
  knowledgeBase      RagKnowledgeBase? @relation(...)

  // Multi-KB sessions: one entry per KB selected for this thread
  kbSessions         RagDiscussionKbSession[]

  title              String
  flowiseSessionId   String   @unique
  difyConversationId String?  // kept for single-KB backward compat
  lastMessageAt      DateTime
  expiresAt          DateTime
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  messages           RagDiscussionMessage[]

  @@index([ownerId, lastMessageAt])
  @@index([expiresAt])
}
```

### 3.4 RagDiscussionKbSession (NEW table)

```prisma
// Tracks per-KB Dify conversation IDs within a multi-KB discussion thread.
// Each KB maintains its own Dify conversation context for follow-up questions.
model RagDiscussionKbSession {
  id                  String              @id @default(cuid())
  threadId            String
  thread              RagDiscussionThread @relation(fields: [threadId], references: [id], onDelete: Cascade)

  knowledgeBaseId     String
  knowledgeBaseName   String              // snapshot of name at session creation
  difyConversationId  String?             // Dify's conversation_id for this KB

  @@unique([threadId, knowledgeBaseId])
  @@index([threadId])
}
```

### 3.5 RagDiscussionMessage (modified)

```prisma
model RagDiscussionMessage {
  id         String              @id @default(cuid())
  threadId   String
  role       String              // "user" | "assistant"
  content    String              // For multi-KB: formatted combined answer
  kbResults  Json?               // Array of {knowledgeBaseId, knowledgeBaseName, answer}
  createdAt  DateTime            @default(now())
  thread     RagDiscussionThread @relation(fields: [threadId], references: [id], onDelete: Cascade)

  @@index([threadId, createdAt])
}
```


---

## 4. API Contract

### 4.1 New/Changed Headers

The API Gateway now forwards three headers to all backend services:

| Header | Value | Source |
|---|---|---|
| `x-user-id` | Keycloak `preferred_username` | JWT claim |
| `x-user-name` | Same as `x-user-id` (kept separate for display) | JWT claim |
| `x-user-roles` | Comma-separated roles | JWT `realm_access.roles` |

### 4.2 Knowledge Base CRUD

#### POST /rag/knowledge-bases — Create KB
**Auth**: Any authenticated user  
**Request**:
```json
{
  "name": "My Docs",
  "description": "Our engineering runbooks",
  "sourceType": "github",
  "sourceUrl": "https://github.com/org/repo",
  "sourceBranch": "main",
  "sourcePath": "docs/"
}
```
**Behavior**: `ownerId` and `ownerUsername` are set from `x-user-id` / `x-user-name` headers automatically. Never accepted from the request body.  
**Response**: Full KB object including `ownerId`, `ownerUsername`.

#### GET /rag/knowledge-bases — List visible KBs
**Auth**: Any authenticated user  
**Behavior**:
- Admin → sees ALL KBs across all users
- Regular user → sees only: KBs where `ownerId = me` OR `RagKbShare.sharedWithId = me`

#### GET /rag/knowledge-bases/:id — Get single KB
**Auth**: Owner, shared user, or admin  
**403** if requestor has no access.

#### PATCH /rag/knowledge-bases/:id — Update KB
**Auth**: Owner or admin only  
**403** for shared users.

#### DELETE /rag/knowledge-bases/:id — Delete KB
**Auth**: Owner or admin only  
Cascades: deletes Vault secrets, Dify app/dataset, all sync jobs, all share records.

### 4.3 KB Share Management

#### POST /rag/knowledge-bases/:id/shares — Share KB with a user
**Auth**: KB owner or admin  
**Request**:
```json
{ "sharedWithUserId": "bali" }
```
**Response**:
```json
{
  "id": "share-cuid",
  "knowledgeBaseId": "kb-cuid",
  "sharedWithId": "bali",
  "sharedById": "platform-admin",
  "permission": "chat",
  "createdAt": "2026-05-01T..."
}
```
**409** if already shared with that user.

#### GET /rag/knowledge-bases/:id/shares — List shares for a KB
**Auth**: KB owner or admin  
**Response**:
```json
{
  "shares": [
    { "id": "...", "sharedWithId": "bali", "sharedById": "platform-admin", "permission": "chat", "createdAt": "..." }
  ]
}
```

#### DELETE /rag/knowledge-bases/:id/shares/:shareId — Revoke share
**Auth**: KB owner or admin  
**204** on success. **404** if share not found or no access.

### 4.4 Chat / Discussions

#### POST /rag/discussions — Create new discussion thread
**Auth**: Any authenticated user  
**Request**:
```json
{ "knowledgeBaseIds": ["kb-id-1", "kb-id-2"] }
```
**Validation**:
- `knowledgeBaseIds` must be non-empty array
- Each KB ID must be visible to the requesting user (owned or shared-with)
- Invalid/inaccessible KB IDs are silently dropped; if all are invalid → 404

**Response**: Thread summary with list of bound KB names.

#### POST /rag/discussions/:id/messages — Send message
**Auth**: Thread owner only (enforced by `ownerId` check)  
**Request**:
```json
{ "content": "How do we deploy to production?" }
```
**Behavior**:
- Queries ALL KBs bound to this thread in **parallel** via Dify
- Each KB uses its own stored `difyConversationId` for session continuity
- If any KB returns 401 → auto-recover key, retry once
- Assembles labeled response

**Response (multi-KB)**:
```json
{
  "mode": "multi",
  "userMessage": { "id": "...", "threadId": "...", "role": "user", "content": "How do we deploy?", "createdAt": "..." },
  "assistantMessage": { "id": "...", "threadId": "...", "role": "assistant", "content": "KB: Operations\n<result>\n\nKB: Developers\n<result>", "createdAt": "..." },
  "results": [
    { "knowledgeBaseId": "kb-id-1", "knowledgeBaseName": "Operations", "ownerUsername": "platform-admin", "answer": "Deploy using docker-compose up -d...", "conversationId": "dify-conv-1" },
    { "knowledgeBaseId": "kb-id-2", "knowledgeBaseName": "Developers", "ownerUsername": "platform-admin", "answer": "The developer guide recommends...", "conversationId": "dify-conv-2" }
  ]
}
```

**Response (single-KB)**:
```json
{
  "mode": "single",
  "userMessage": { "id": "...", "role": "user", "content": "...", "createdAt": "..." },
  "assistantMessage": { "id": "...", "role": "assistant", "content": "Deploy using docker-compose up -d...", "createdAt": "..." },
  "results": [
    { "knowledgeBaseId": "kb-id-1", "knowledgeBaseName": "Operations", "ownerUsername": "platform-admin", "answer": "Deploy using docker-compose up -d...", "conversationId": "dify-conv-1" }
  ]
}
```

#### GET /rag/discussions — List my discussions
**Auth**: Any authenticated user  
Returns only threads where `ownerId = requesting user`. Admin does NOT see other users' threads here — this is by design (personal workspace).

#### GET /rag/discussions/:id — Get thread + messages
**Auth**: Thread owner only. Returns kbResults per message for rich rendering.

#### DELETE /rag/discussions/:id — Delete thread
**Auth**: Thread owner only.


---

## 5. Chat Session Isolation

Each user's discussion history is **strictly private**:

- `RagDiscussionThread.ownerId` = the user who created the thread
- All thread queries filter by `ownerId = requestingUserId`
- No endpoint exposes another user's threads, even to admins (admins have separate audit log access via the Logs page)
- Sharing a KB with user `bali` does NOT give them access to the owner's existing threads — they start fresh threads of their own against that KB
- The Dify `user` field passed in each chat request is the `ownerId`, so Dify also isolates conversation analytics per user

**Example isolation scenario:**
```
platform-admin owns KB "Operations" and shares it with bali.

platform-admin asks: "What is our deployment runbook?"
→ Creates thread T1 (ownerId: platform-admin)
→ Dify conversation C1 created for platform-admin

bali asks: "What is our deployment runbook?"
→ Creates thread T2 (ownerId: bali)
→ Dify conversation C2 created for bali

Neither user sees the other's T1/T2 thread in their discussion list.
```

---

## 6. Dify API Key Auto-Recovery

### Problem
When `dify-api` or `dify-worker` restarts with a fresh or reset database, the `api_tokens` table is cleared. Keys stored in Vault become invalid (Dify returns 401). Previously this required manual operator intervention.

### Solution: On-Demand Auto-Heal

The `sendToDify()` function implements a single-retry auto-recovery pattern:

```
1. Attempt Dify chat request with stored API key from Vault
2. If response is 200 → return answer (fast path, zero overhead)
3. If response is 401:
   a. Log "DIFY_KEY_STALE — attempting auto-recovery for kbId"
   b. Login to Dify console using credentials from Vault (platform/global/dify/config)
   c. Create a new app API key via POST /console/api/apps/{appId}/api-keys
   d. Write the new key to Vault (platform/global/dify/{kbId} → app_api_key)
   e. Retry the original request once with the new key
   f. If still 401 → throw DIFY_AUTH_RECOVERY_FAILED (surface to user)
4. Any other error → throw immediately (no retry)
```

### Why only on 401
- Zero overhead on the normal (happy) path
- Avoids false-positive retries that could mask real auth logic bugs
- Recovery is fast (<500ms additional latency for the one failing request)

### Vault Key Structure (unchanged)
```
Vault path: secret/data/platform/global/dify/{kbId}
Fields:
  app_api_key     — Dify App API key (used for chat)
  api_key         — Legacy alias, same value
  dataset_api_key — Dify Dataset API key (used for sync)
  app_id          — Dify App ID
  dataset_id      — Dify Dataset ID
  n8n_workflow_id — n8n workflow for sync
```

---

## 7. Migration Strategy

### Existing KBs (scope: "global")
The two existing KBs (`cmonjw8nn00022gsom7mzb3su`, `cmonk26r400092gsou92y35dk`) will be handled manually by the platform admin after deployment:

1. Run migration (adds `ownerUsername` column, creates `RagKbShare` and `RagDiscussionKbSession` tables, removes `scope` column)
2. Existing KBs get `ownerId` set to the value already in the DB (they currently have `ownerId` set from `createdById`)
3. `ownerUsername` defaults to the existing `ownerId` value
4. Platform admin manually shares existing KBs with desired users via the new share API
5. No data is lost — existing discussion threads remain linked to their `knowledgeBaseId`

---

## 8. Acceptance Criteria

### KB Ownership
- [ ] Creating a KB sets `ownerId` from `x-user-id` header; body cannot override it
- [ ] `ownerUsername` is stored and returned in all KB responses
- [ ] Regular user cannot see another user's KBs (403/empty list)
- [ ] Admin can see all KBs via GET /rag/knowledge-bases

### Sharing
- [ ] Owner can share KB with another user by their username (preferred_username)
- [ ] Admin can share any KB with any user
- [ ] Shared user sees the KB in their list with read-only indicators
- [ ] Shared user cannot edit, delete, or sync the KB (403)
- [ ] Owner can revoke a share; revoked user immediately loses access
- [ ] Sharing same user twice returns 409

### Multi-KB Chat
- [ ] POST /rag/discussions requires `knowledgeBaseIds` array
- [ ] Thread is bound to selected KBs; queries are sent in parallel
- [ ] Response includes `results` array with per-KB labeled answers
- [ ] Single-KB response has `mode: "single"`, multi-KB has `mode: "multi"`
- [ ] Each KB's Dify conversation_id is tracked separately for follow-up context
- [ ] User cannot select a KB they don't have access to (silently dropped)

### Chat Isolation
- [ ] User A's threads never appear in User B's discussion list
- [ ] Thread owner check is enforced on all thread operations (get, message, delete)
- [ ] Sharing a KB does NOT expose the owner's existing thread history to the shared user

### Dify Key Auto-Recovery
- [ ] When Dify returns 401, the service auto-heals: logs in, creates new key, updates Vault, retries
- [ ] Successful auto-recovery is transparent to the user (they receive the answer)
- [ ] If auto-recovery also fails (second 401), error DIFY_AUTH_RECOVERY_FAILED is returned
- [ ] Normal 200 responses have zero additional overhead (no pre-flight checks)

---

## 9. Implementation Checklist

- [x] PRD written and approved
- [ ] DB schema updated (Prisma schema.prisma)
- [ ] DB migration created and applied
- [ ] API Gateway: x-user-name header forwarded
- [ ] Workflow-service: KB CRUD updated (owner enforcement, ownerUsername stored)
- [ ] Workflow-service: Share endpoints (POST/GET/DELETE /rag/knowledge-bases/:id/shares)
- [ ] Workflow-service: Multi-KB fan-out chat with labeled responses
- [ ] Workflow-service: Dify key auto-recovery on 401
- [ ] Contracts package: Updated TypeScript types
- [ ] Frontend: Chat UI renders labeled per-KB results
- [ ] Frontend: Share management UI in integrations page

