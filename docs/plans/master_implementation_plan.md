# Master Implementation Plan

## Current milestone
- Milestone 6: Big-bang replatform to canonical flow + React Flow + Temporal + Flowise planner-only.

## Completed
- Monorepo foundation, shared contracts, shared engine-core package, lint/test/build wiring.
- Core data model and migrations for workflows, versions, orders, checkpoints, status transitions, step executions, logs, approvals, integrations, environments, and sharing.
- Service implementation for `api-gateway`, `workflow-service`, `order-service`, `execution-engine`, `integration-service`, `logging-service`, and `web`.
- Workflow builder + order execution + approvals + logs UI flows.
- Keycloak-backed auth, registration, profile/password, and admin user lifecycle management.
- Owner/shared scope enforcement for non-admin paths across integrations/environments/orders.
- Vault-first secret model with strict sensitive plaintext blocking and admin secret management surface.
- TLS runtime, per-service Vault agent cert distribution, rotation controller, and secure-only transport baseline.
- Offline production deployment path via GitLab container registry and `docker-compose.prod.yml`.
- Admin reset endpoints for workflows/orders with dry-run preview and explicit confirmation.
- Canonical workflow contract (`schemaVersion: v2`) with validation and publish gates.
- React Flow-based workflow builder baseline with planner prompt support.
- Temporal and Flowise services wired into compose baseline and app config.

## In progress
- None. Milestone 6 is complete.

## Next resume point
- Run `tests/smoke/canonical-temporal-e2e-smoke.sh` and `tests/smoke/flowise-planner-smoke.sh` to verify end-to-end operations using real Keycloak tokens via API Gateway.
