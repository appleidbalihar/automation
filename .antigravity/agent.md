# AI Agent Context: Enterprise Automation Platform

## 1. System Overview
This project is an **Enterprise Automation Platform** built as a microservices architecture in a `pnpm` workspace with `turborepo`. It performs highly resilient system automation flows and features a No-Code UI powered by React Flow.

## 2. Tech Stack Overview
- **Core Languages:** Node.js (TypeScript), Next.js 15, React 19.
- **Backend Frame:** Fastify, AMQP (RabbitMQ), ioRedis.
- **Infrastructure:** Docker Compose, Keycloak (Auth), Vault (Dynamic TLS/Secrets), MinIO.
- **Workspaces Builder:** `turbo`, `pnpm`.

## 3. Directory Layout
- **`apps/web/`**: Next.js 15 app for the UI. Drag-and-drop nodes using React Flow.
- **`apps/api-gateway/`**: Fastify gateway centralizing all APIs, enforcing auth checks.
- **`apps/workflow-service/`**: Core execution engine for processing nodes, retries, and rollbacks.
- **`apps/logging-service/`**: Microservice handling step-level and platform logs.
- **`packages/*/`**: Reusable modules shared between apps (contracts, ui-kit, db abstractions).
- **`docs/`**: Developer and Operational documentation separated neatly.

## 4. Fundamental Rules / Design Principles
- UI must be Enterprise Grade, Responsive, supporting Dark/Light Themes.
- Ensure API-First development with Swagger & Postman collections maintained.
- All code must follow the 500-lines per file maximum rule for new files.
- Refer strictly to `.antigravity/context/project_context.json` as the unified source of truth.
