# Operations Guide: Platform Overview

## What the platform does
- Build workflows visually.
- Run orders against target nodes.
- Skip already configured items.
- Retry, continue, or roll back based on configured policy.
- Review status timelines and masked logs.

## Failure handling
- The system keeps execution checkpoints after successful steps.
- If execution stops unexpectedly, the platform resumes from the last saved checkpoint instead of restarting from the beginning.
- Operators can inspect failure reasons and choose retry or rollback where allowed.

## Access model
- `admin`: full administration
- `operator`: execute and monitor orders
- `approver`: approve gated nodes
- `viewer`: read-only access
