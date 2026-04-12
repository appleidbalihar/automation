# Developer Guide: Workflow Builder UI

## Overview
The web app now includes an interactive workflow builder panel with draft composition and publish controls.

## Component
- `apps/web/src/app/workflow-builder.tsx`

## Supported interactions
- Draft metadata editing (`name`, `description`)
- Node add/remove
- Step add/remove per node
- Step execution type and retry policy editing
- Save draft as new workflow via `POST /workflows`
- Publish selected workflow via `POST /workflows/:id/publish`
- Version awareness via `GET /workflows/:id`

## Auth behavior
- Reuses the same local token storage key as operations panels: `ops_bearer_token`
- Sends bearer token to gateway when available
- Honors gateway RBAC responses (admin required for publish)

## Current v1 limitation
- Existing draft versions are not edited in place yet because workflow-service currently exposes create/list/get/publish endpoints only.
- UI supports save-as-new draft workflows until update/version-clone APIs are introduced.
