# Operations Guide: Platform Overview

## What The Platform Does

- Connect document sources in Knowledge Connector.
- Sync supported files into Dify-backed knowledge bases.
- Answer questions in RAG Assistant.
- Manage reusable AI agent prompt templates.
- Review sanitized operational logs.
- Manage platform secrets, users, RAG stats, and certificate/security health.

## Day-To-Day Operations

- Use `/knowledge-connector` to create sources (provider picker opens directly — choose GitHub, GitLab, Google Drive, Web URL, or PAT), update credentials, sync, cleanup, share, and inspect sync progress.
- Use `/rag-assistant` for documentation-backed questions.
- Use `/ai-agent-prompt` (shown as **AI Agent** in sidebar) to manage prompt templates and reusable KB agent behavior.
- Use `/chat-channels` to create and manage Slack bots and link your personal Slack identity. **Section 1 — My Bots**: create bots (Bot token, Signing secret, Client ID, Client Secret — all required), set share scope and access mode, manage Members panel. **Section 2 — My Slack Connections**: all accessible bots (owned + shared); click Connect to link your Slack ID via OAuth and choose your KBs. The bot owner's entry in the Members panel starts as "Not linked" until they complete the Connect flow themselves.
- Use `/rag-stats` for admin-only RAG timing statistics.
- Use `/logs` for admin-only platform log investigation.
- Use `/secrets`, `/users`, and `/security` for admin work.

## Access Model

- `admin`: full administration.
- `useradmin`: user administration and KB operations allowed by gateway routes.
- `operator`: sync and RAG operations.
- `approver`: read/chat access where routes allow it.
- `viewer`: read/chat access where routes allow it.

System-wide logs are admin-only. Sync-job scoped logs are available to admin, useradmin, and operator.

## Runtime Backends

- Dify owns datasets, apps, document indexing, and chat completion calls. If a Dify app is deleted externally, the next sync auto-detects the stale app ID and recreates it.
- n8n owns source sync workflow execution and progress callbacks.
- Vault stores source tokens, OAuth tokens, OAuth app credentials, Dify API keys, and Slack bot credentials.
- Redis caches Slack signing secrets (2 h) and bot tokens (1 h) per deployment to keep slash command response times under Slack's 3-second limit. Cache is cleared immediately on any bot update, deactivate, or delete.
- PostgreSQL stores platform metadata, sync jobs, logs, prompt templates, shares, discussion records, and Slack user–KB mappings.
