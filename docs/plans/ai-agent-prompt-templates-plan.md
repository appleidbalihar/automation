# AI Agent Prompt Templates — Implementation Plan

**Feature:** Separate System Prompt Template management page, with templates applied to Knowledge Base sources.  
**Date:** 2026-05-07  
**Status:** In Progress

---

## Problems Being Solved

1. **RAG leaks confidential info** — Generic system prompts allow the AI to repeat API keys, passwords, usernames found in indexed documents. Fix: every template includes a hard "never expose credentials" rule, plus the platform default prompt is upgraded.
2. **System prompt buried in Integration flow** — KB Instructions are scattered across Create/Edit modals. Fix: move to a dedicated "AI Agent Prompt" page.
3. **No template reuse** — Users type prompts from scratch each time. Fix: shared library of role-specific best-practice templates.
4. **Generic prompts give poor RAG quality** — No faithfulness rules, no confidence handling, no source citation. Fix: rewrite platform default prompt using established RAG best practices.

---

## Architecture

### New Page: `/ai-agent-prompt`

Dedicated page for template management, accessible from the navigation sidebar.

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent Prompt                           │
│  Navigation: admin + useradmin roles only                   │
│                                                              │
│  [Template Cards Grid]                                       │
│  Tabs: All | Built-in | My Templates | Shared with Me        │
│                                                              │
│  Each card:                                                  │
│    - Name + category badge (DevOps / Developer / etc.)       │
│    - Description + owner                                     │
│    - Actions: Edit | Duplicate | Share | Delete              │
│    - 🔒 Lock icon on built-in (read-only for non-admins)    │
└─────────────────────────────────────────────────────────────┘
```

### Integration Page Changes

```
Create Source Modal:
  REMOVED: "KB Instructions" textarea + Generate button
  ADDED:   "AI Agent Template" dropdown (required, pre-selected = General Assistant)

Edit Source Modal:
  REMOVED: KB Instructions section entirely
  KEPT:    Source details, branch, paths, credentials

Configure Prompt Panel (🤖 button on KB row):
  REDESIGNED:
    Current Template: [DevOps Engineer 🔧]   ← always shown
    Change Template:  [▼ dropdown ▾]
                      [Apply Template] → pushes to Dify immediately
    ▶ Fine-tune (optional)
       Additional instructions on top of template
       Response Style dropdown
       Tone / Restriction inputs
       ✦ Generate (smart: Recommend vs Improve)
       [Save Fine-tune]
```

---

## Role-Based Access

| Role | Permissions |
|------|-------------|
| `admin` (platformadmin) | Create/edit/delete all templates; share to any user or all users; see every template; create built-in templates |
| `useradmin` | Create/edit/delete own templates; share with specific users; see own + shared + built-ins |
| `user` (regular) | View templates shared with them + built-ins; duplicate to own namespace |

---

## Database Changes

### New Models

```prisma
model SystemPromptTemplate {
  id               String   @id @default(cuid())
  name             String
  description      String?
  category         String   // "general"|"devops"|"developer"|"solution_architect"|"security"|"custom"
  systemPromptBase String   // Main prompt content
  responseStyle    String?
  toneInstructions String?
  restrictionRules String?
  ownerId          String   // "platform" for built-ins
  ownerUsername    String
  isBuiltIn        Boolean  @default(false)
  shareScope       String   @default("private") // "private"|"all"|"specific"
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  shares           SystemPromptTemplateShare[]
  knowledgeBases   RagKnowledgeBase[]
}

model SystemPromptTemplateShare {
  id           String               @id @default(cuid())
  templateId   String
  template     SystemPromptTemplate @relation(...)
  sharedWithId String
  createdAt    DateTime @default(now())
  @@unique([templateId, sharedWithId])
}
```

### Updated: `RagKnowledgeBase`
- Added `templateId String?` — FK to `SystemPromptTemplate`

---

## Backend API Endpoints (workflow-service)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/rag/prompt-templates` | List templates visible to caller |
| POST | `/rag/prompt-templates` | Create new template |
| PATCH | `/rag/prompt-templates/:id` | Update template (owner or admin) |
| DELETE | `/rag/prompt-templates/:id` | Delete template (owner or admin) |
| POST | `/rag/prompt-templates/:id/duplicate` | Duplicate to caller's namespace |
| POST | `/rag/prompt-templates/:id/share` | Share with user(s) or all |
| DELETE | `/rag/prompt-templates/:id/share/:userId` | Revoke share |
| POST | `/rag/knowledge-bases/:id/apply-template` | Apply template to KB + push to Dify |
| POST | `/rag/prompt-templates/generate` | AI generate/improve prompt (smart mode) |

---

## ✦ Generate Button — Smart Behaviour

| Field State | Button Label | Action |
|-------------|-------------|--------|
| Empty | **✦ Recommend Best Practice** | Generates complete role-appropriate template from scratch |
| Has text | **✦ Generate / Improve** | Rewrites draft using best-practice RAG structure |

### Generate Request Body
```json
{
  "description": "optional — user's rough draft",
  "category": "devops|developer|solution_architect|security|general",
  "templateName": "optional",
  "mode": "improve|recommend"
}
```

The meta-prompt used for generation encodes all 8 RAG best practices:
- Role context + domain identification
- Source attribution format
- Faithfulness rules (answer only from retrieved context)
- Credential security (never expose secrets)
- Confidence level handling (high/medium/low)
- Domain-specific response formatting
- Topic scope and restrictions
- Clarifying question guidance

---

## Built-In Templates (Seeded on Startup)

| Name | Category | Key Behaviours |
|------|----------|----------------|
| General Assistant | `general` | All-domain, cites sources, confidence statements |
| DevOps Engineer | `devops` | Step-by-step commands, runbooks, infra, rollback steps |
| Developer | `developer` | Code blocks, architecture patterns, version refs, debug |
| Solution Architect | `solution_architect` | Trade-off analysis, cloud patterns, decision frameworks |
| Security Engineer | `security` | CVEs, compliance, risk-first, never reveals credentials |

**All templates include:**
- Credential security rule: never repeat API keys, passwords, tokens, secrets
- Source attribution: [Source: document_name]
- Faithfulness: answer only from retrieved context
- Confidence handling: explicit uncertainty statements

---

## Platform Default Prompt Upgrade

The `PLATFORM_DEFAULT_SYSTEM_PROMPT` in `workflow-service/src/main.ts` is rewritten to include:

1. **Identity & Grounding** — Answer only from retrieved context
2. **Credential Security** (ABSOLUTE) — Never reveal API keys, passwords, tokens, secrets
3. **Source Attribution** — [Source: document_name] on every factual claim
4. **Confidence Levels** — High / Medium / Low with explicit prefixes
5. **Domain Adaptation** — Placeholder for role-specific template injection
6. **Faithfulness** — Every claim traceable to retrieved text
7. **Interaction** — Ask clarifying questions when ambiguous
8. **Response Structure** — Direct answer → Details → Sources → Follow-up

---

## Frontend File Map

| File | Change | New? |
|------|--------|------|
| `apps/web/src/app/(platform)/ai-agent-prompt/page.tsx` | New page route | ✅ New |
| `apps/web/src/app/prompt-templates/PromptTemplatesPage.tsx` | Main page component | ✅ New |
| `apps/web/src/app/prompt-templates/TemplateEditorModal.tsx` | Create/Edit modal | ✅ New |
| `apps/web/src/app/prompt-templates/TemplateCard.tsx` | Template card component | ✅ New |
| `apps/web/src/app/prompt-templates/api.ts` | Frontend API client | ✅ New |
| `apps/web/src/app/prompt-templates/types.ts` | TypeScript types | ✅ New |
| `apps/web/src/app/navigation-sidebar.tsx` | Add "AI Agent Prompt" nav item | Modified |
| `apps/web/src/app/integrations/CreateSourceModal.tsx` | Remove KB Instructions, add template selector | Modified |
| `apps/web/src/app/integrations/EditSourceModal.tsx` | Remove KB Instructions | Modified |
| `apps/web/src/app/integrations/SystemPromptPanel.tsx` | Redesign as template switcher + fine-tune | Modified |
| `apps/web/src/app/integrations/types.ts` | Add templateId, templateName to Integration | Modified |

---

## Backend File Map

| File | Change | New? |
|------|--------|------|
| `apps/workflow-service/src/prompt-templates.ts` | Template CRUD routes + seeding | ✅ New |
| `apps/workflow-service/src/main.ts` | Upgrade platform prompt, upgrade generate endpoint, add apply-template route, register template routes | Modified |
| `packages/db/prisma/schema.prisma` | Add SystemPromptTemplate + SystemPromptTemplateShare models, templateId on RagKnowledgeBase | Modified |
| `packages/db/prisma/migrations/20260507000000_add_prompt_templates/migration.sql` | SQL migration | ✅ New |

---

## Implementation Checklist

### Completed
- [x] DB schema updated (SystemPromptTemplate + SystemPromptTemplateShare + templateId FK)
- [x] Migration SQL created (`20260507000000_add_prompt_templates`)
- [x] Backend: `prompt-templates.ts` — helper functions, BUILT_IN_TEMPLATES, seedBuiltInTemplates, mapTemplateRow, canModifyTemplate
- [x] Backend: CRUD routes for `/rag/prompt-templates` (list, get, create, patch, delete, duplicate, share, revoke) added to `main.ts`
- [x] Backend: `POST /rag/knowledge-bases/:id/apply-template` route added to `main.ts`
- [x] Backend: `POST /rag/prompt-templates/generate` — smart mode (recommend vs improve) added to `main.ts`
- [x] Backend: `seedBuiltInTemplates()` called on startup in `main.ts`
- [x] Backend: `PLATFORM_DEFAULT_SYSTEM_PROMPT` upgraded — includes credential security (ABSOLUTE) rule + full RAG best practices
- [x] Frontend: `prompt-templates/types.ts` — PromptTemplate, TemplateFormState, CATEGORY_LABELS, CATEGORY_ICONS
- [x] Frontend: `prompt-templates/api.ts` — all API client functions
- [x] Frontend: `prompt-templates/TemplateCard.tsx` — template card with edit/duplicate/delete actions
- [x] Frontend: `prompt-templates/TemplateEditorModal.tsx` — create/edit modal with smart Generate button
- [x] Frontend: `prompt-templates/PromptTemplatesPage.tsx` — tabbed page with grid of template cards
- [x] Frontend: `(platform)/ai-agent-prompt/page.tsx` — Next.js route
- [x] Frontend: `navigation-sidebar.tsx` — "AI Agent Prompt" nav item for admin + useradmin
- [x] Frontend: `integrations/types.ts` — `templateId`, `templateName` added to Integration; `templateId` added to IntegrationForm + EMPTY_FORM
- [x] Frontend: `integrations/CreateSourceModal.tsx` — KB Instructions removed; AI Agent Template dropdown added (auto-fetches templates, pre-selects General Assistant)
- [x] Frontend: `integrations/EditSourceModal.tsx` — no KB Instructions were present (already clean)
- [x] Frontend: `integrations/SystemPromptPanel.tsx` — redesigned as template switcher + fine-tune panel
- [x] Frontend: `integrations-page.tsx` — templateId/templateName props passed to SystemPromptPanel
- [x] Frontend: `globals.css` — CSS classes for tpl-page, tpl-card, tpl-grid, tpl-tabs, tpl-form, tpl-selector, tpl-current, tpl-change, tpl-finetune, tpl-badge

### Remaining
- [ ] Deploy: Run migration (`20260507000000_add_prompt_templates`), rebuild containers, verify API
- [ ] Verify: `templateId` is passed through from integration create/edit APIs to backend (check `integrations-page.tsx` submit handlers)

---

## Data Flow

```
User creates KB
  → selects template from dropdown
  → POST /rag/integrations { templateId }
  → backend copies template prompt into RagKnowledgeBaseConfig
  → stores templateId on RagKnowledgeBase

User changes template on KB
  → POST /rag/knowledge-bases/:id/apply-template { templateId }
  → backend fetches template text
  → builds composed prompt (template + platform default)
  → pushes to Dify app via console API
  → updates RagKnowledgeBase.templateId + RagKnowledgeBaseConfig.systemPromptBase

User fine-tunes KB config
  → PATCH /rag/knowledge-bases/:id/config
  → overrides layered on top of template text
  → prompt layers: [Template] + [Fine-tune] + [Platform Default]
```
