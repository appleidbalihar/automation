# Operations Guide: Platform Overview

## What The Platform Does

- Connect document sources in Knowledge Connector.
- Sync supported files into Dify-backed knowledge bases.
- Answer questions in RAG Assistant.
- Review sanitized operational logs.
- Manage platform secrets, users, and certificate/security health.

## Day-To-Day Operations

- Use `/knowledge-connector` to create sources, update credentials, sync, cleanup, share, and inspect sync progress.
- Use `/rag-assistant` for documentation-backed questions.
- Use `/logs` for admin-only platform log investigation.
- Use `/secrets`, `/users`, and `/security` for admin work.

## Access Model

- `admin`: full administration.
- `useradmin`: user administration and KB operations allowed by gateway routes.
- `operator`: sync and RAG operations.
- `approver`: read/chat access where routes allow it.
- `viewer`: read/chat access where routes allow it.

System-wide logs are admin-only. Sync-job scoped logs are available to admin, useradmin, and operator.
