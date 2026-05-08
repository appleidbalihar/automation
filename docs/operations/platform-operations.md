# Operations Guide: Platform Overview

## What The Platform Does

- Connect document sources in Knowledge Connector.
- Sync supported files into Dify-backed knowledge bases.
- Answer questions in RAG Assistant.
- Manage reusable AI agent prompt templates.
- Review sanitized operational logs.
- Manage platform secrets, users, RAG stats, and certificate/security health.

## Day-To-Day Operations

- Use `/knowledge-connector` to create sources, update credentials, sync, cleanup, share, and inspect sync progress.
- Use `/rag-assistant` for documentation-backed questions.
- Use `/ai-agent-prompt` to manage prompt templates and reusable KB agent behavior.
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

- Dify owns datasets, apps, document indexing, and chat completion calls.
- n8n owns source sync workflow execution and progress callbacks.
- Vault stores source tokens, OAuth tokens, OAuth app credentials, and Dify API keys.
- PostgreSQL stores platform metadata, sync jobs, logs, prompt templates, shares, and discussion records.
