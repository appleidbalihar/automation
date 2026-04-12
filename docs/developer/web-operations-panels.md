# Developer Guide: Web Operations Panels

## Overview
The web dashboard now renders live operations panels for:
- workflow publish audits
- RAG indexing jobs

## Component
- `apps/web/src/app/ops-panels.tsx`

## Data sources
- `GET /workflows` (viewer)
- `GET /workflows/:id/publish-audits`
- `GET /rag/jobs` (viewer)
- `GET /auth/me`
- Action calls:
  - `POST /workflows/:id/publish`
  - `POST /rag/index`
  - `POST /orders/execute`
  - `POST /orders/:id/retry`
  - `POST /orders/:id/rollback`

## Behavior
- Polls key endpoints every 6 seconds.
- Displays workflow selector for publish-audit inspection.
- Shows compact status tables with timestamp formatting and status badges.
- Provides role-aware action controls (admin/operator/viewer) and disables restricted actions for non-authorized roles.
- Shows live action feedback and selected workflow version context.

## Notes
- API base is read from `NEXT_PUBLIC_API_BASE_URL`.
- Panel stores an optional bearer token in local storage (`ops_bearer_token`) and uses `/auth/me` to infer role-aware action enablement.
