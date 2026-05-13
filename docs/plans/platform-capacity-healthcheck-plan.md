# RapidRAG — Platform Capacity & Health Check Plan

**Date:** 2026-05-12
**Author:** Platform Engineering
**Status:** Draft for Review

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Resource Limits per Container](#2-current-resource-limits-per-container)
3. [RAM & CPU — When Is Memory Freed?](#3-ram--cpu--when-is-memory-freed)
4. [Concurrency Capacity — 100 Concurrent Users](#4-concurrency-capacity--100-concurrent-users)
5. [Vector Storage Growth Model](#5-vector-storage-growth-model)
6. [Health Check Implementation Plan](#6-health-check-implementation-plan)
7. [Monitoring & Alerting](#7-monitoring--alerting)
8. [Scaling Strategy](#8-scaling-strategy)
9. [Implementation Checklist](#9-implementation-checklist)

---

## 1. Executive Summary

The platform currently runs ~30 Docker containers on a single host (Docker Compose). This document answers three critical operational questions:

1. **RAM/CPU**: How much does each container consume, when is memory freed, and what happens under load?
2. **Concurrency**: Can the platform handle 100 simultaneous users asking questions?
3. **Storage**: How fast does pgvector/MinIO grow as more KBs are added?

**Verdict:** At current `docker-compose.prod.yml` limits, the platform is configured for approximately **20–40 concurrent RAG queries** before Dify becomes the bottleneck. Reaching 100 concurrent users requires either horizontal scaling (multiple Dify workers) or request queuing. This plan defines the health checks, alerting thresholds, and scaling steps to reach 100-user capacity safely.

## 2. Current Resource Limits per Container

These are the hard limits set in `docker-compose.prod.yml`. Docker OOM-kills a container the moment it exceeds `mem_limit`.

| Container | mem_limit | cpus | Role | Notes |
|-----------|-----------|------|------|-------|
| `postgres` (platform DB) | 1 GB | 1.0 | Platform DB (Prisma) | Shared by all app services |
| `redis` | 256 MB | 0.5 | Cache, Slack dedup, rate limiting | Small footprint; evicts LRU keys |
| `rabbitmq` | 512 MB | 0.5 | Event bus (log ingest, cert rotation) | Needs headroom for large message bursts |
| `dify-api` | 2 GB | 1.0 | Dify API server — chat, KB mgmt, indexing | **Highest RAM consumer; LLM context in memory** |
| `dify-worker` | 512 MB | 0.5 | Celery async indexing/embedding worker | Shares Dify image; embedding batches spike RAM |
| `dify-web` | 512 MB | 0.5 | Dify admin console UI (Next.js) | Rarely accessed; low priority |
| `keycloak` | 1 GB | 0.5 | OIDC identity provider | JVM heap — slow to start, stable when warm |
| `opensearch` | 1 GB | 1.0 | Log search backend | JVM heap — needs `ES_JAVA_OPTS` tuned |
| `minio` | 512 MB | 0.5 | S3-compatible object storage | RAM for metadata cache; disk for data |
| `vault` | 512 MB | 0.5 | Secret management + PKI CA | Low steady-state RAM |
| `n8n` | 512 MB | 0.5 | Sync workflow runner | Spikes during multi-file sync jobs |
| `api-gateway` | 256 MB | 0.25 | Fastify JWT gateway | Stateless; very low RAM |
| `workflow-service` | 512 MB | 0.5 | RAG orchestration (Fastify) | Handles all concurrent chat requests |
| `web` (Next.js UI) | 256 MB | 0.5 | Platform frontend | SSR pages; low RAM per request |
| `logging-service` | 512 MB | 0.5 | Log ingest + query | Buffers log payloads from RabbitMQ |
| `postgres` (Dify internal) | 1 GB | 1.0 | Dify's own DB + pgvector | **Grows with vector embeddings** |
| Sidecar containers | 256 MB each | — | vault-agent, cert-rotation, db-migrate | Short-lived or low steady-state |

**Total configured RAM ceiling: ~12 GB across all containers**

> ⚠️ **Critical:** If your host has less than 16 GB RAM, containers will start competing for memory. The OS kernel OOM killer will terminate the container with the highest memory usage — typically `dify-api` or `opensearch`. This causes silent failures for active chat sessions.

## 3. RAM & CPU — When Is Memory Freed?

The user asked: *"When will the RAM CPU memory be cleared?"*

### Dify API (`dify-api` / `dify-worker`)
- **When allocated:** Memory spikes when a user sends a message. Dify loads the retrieved vector chunks, conversation history, and prepares the prompt for the LLM. For document indexing, `dify-worker` loads files into RAM to chunk and embed them.
- **When freed:** Python's garbage collector frees memory **immediately after the request finishes** or the indexing task completes.
- **Leak risk:** Under sustained heavy load, Python Celery workers can experience memory fragmentation. Dify handles this internally by recycling worker processes after a certain number of tasks.

### Node.js Services (`workflow-service`, `api-gateway`)
- **When allocated:** Memory is allocated for the HTTP request, JSON parsing, and DB query results.
- **When freed:** V8 Garbage Collection runs periodically. The `workflow-service` is highly efficient — it streams the Dify request so the entire LLM response doesn't sit in memory at once. It should comfortably stay under 150 MB even under load.

### Databases (`postgres`, `redis`, `opensearch`)
- **When allocated:** Databases use memory for caching (shared buffers, buffer pool).
- **When freed:** **They do not "clear" memory back to the OS.** This is by design. PostgreSQL and OpenSearch will use as much RAM as you allow them to cache data for faster reads. They manage their internal cache eviction (LRU - Least Recently Used). If you see `postgres` using 900MB out of its 1GB limit, that is healthy — it means its cache is warm.

## 4. Concurrency Capacity — 100 Concurrent Users

The user asked: *"If 100 users asking questions then we face capacity issue is that correct?"*

**Yes. With a single `dify-api` container capped at 2 GB RAM and 1.0 CPU, 100 concurrent requests will fail.**

### Bottleneck Analysis

1. **`workflow-service` (Fastify)**: Can easily handle 500+ concurrent requests. Fastify is highly optimized for asynchronous I/O.
2. **`api-gateway`**: Can handle 1000+ concurrent requests.
3. **`dify-api` (Python/Flask/Gunicorn)**: **This is the bottleneck.**
   - Dify handles chat requests synchronously using Gunicorn worker threads.
   - Each active chat request consumes ~50 MB RAM and blocks a worker thread while waiting for the LLM API to respond.
   - If 100 users ask a question at the exact same second, Dify needs 100 worker threads.
   - 100 threads × 50 MB = 5 GB RAM. (Exceeds the 2 GB limit → OOM Kill).
   - If Dify is configured with fewer threads (e.g., 4 or 8), requests 9 through 100 will queue up. If the queue times out, users see a `502 Bad Gateway` or `504 Gateway Timeout`.

### Realistic Capacity

- **Simultaneous vs. Active Users:** 100 "active" users on the platform does not mean 100 concurrent queries. Users spend time reading answers and typing. 100 active users typically generate **2–5 concurrent requests per second**.
- **Current Setup Capacity:** The current 2GB `dify-api` container can comfortably handle **10–15 strictly simultaneous** requests. This is enough for ~300 active users online at the same time.
- **True 100 Concurrency:** If you actually expect 100 users to click "Send" at the exact same second (e.g., a coordinated live demo or automated load test), the current setup will fail.

## 5. Vector Storage Growth Model

The user asked: *"consider all these concerns like ... vector data storage"*

### Sizing Rules of Thumb
- **Raw Document Text:** 1 MB of raw text = ~500 pages.
- **MinIO Storage:** Stores the original files. 10,000 PDFs averaging 2 MB = **20 GB**.
- **pgvector Storage:** This is the critical factor.
  - Dify chunks text into ~500-token segments.
  - Each chunk gets a vector embedding (typically 1536 dimensions for `text-embedding-3-small`).
  - 1 vector = ~6 KB in PostgreSQL (including metadata and index overhead).
  - 1 MB of raw text ≈ 500 chunks = **~3 MB of pgvector database size**.
  - **Multiplier:** pgvector data takes about **3x the size of the raw text**.

### Capacity Outlook
- The internal `postgres` container is capped at 1 GB RAM.
- PostgreSQL needs enough RAM to keep the active vector index (HNSW or IVFFlat) in memory for fast searches.
- At ~1 million chunks (approx. 2 GB raw text), the vector index will consume ~200–300 MB RAM. This fits well within the 1 GB limit.
- **Verdict:** Vector storage is not a near-term bottleneck for memory, but disk I/O will become a bottleneck if the database exceeds RAM size and starts swapping to disk during vector searches.

## 6. Health Check Implementation Plan

To provide the admin team with visibility into these capacity limits, we will build a **System Capacity Dashboard** into the existing web UI (next to the Security Health Panel).

### 6.1 Backend API (`GET /admin/health/capacity`)
Add a new endpoint in `workflow-service` or `api-gateway` that gathers real-time metrics:
- **Docker Stats:** Call `docker stats --no-stream --format json` (requires docker socket mount, or a lightweight host-level agent).
- **PostgreSQL Stats:** Query `pg_stat_database` for DB size and cache hit ratio.
- **Redis Stats:** Run `INFO memory` to get used memory.
- **Dify Stats:** Query Dify's internal DB for total dataset chunk counts to estimate vector index size.

### 6.2 Frontend UI (`apps/web/src/app/capacity-panel.tsx`)
Create a new admin dashboard component that displays:
- **Memory Pressure:** Progress bars for each container showing `Usage / Limit`. Turns red if >85%.
- **Active Concurrency:** Current number of active threads/requests in `dify-api`.
- **Storage Growth:** Current pgvector size and estimated chunk count.
- **OOM Kill Count:** Count of containers killed due to memory limits in the last 24h.

## 7. Monitoring & Alerting

Configure the `logging-service` to emit Slack alerts to the admin channel when capacity thresholds are breached.

| Metric | Warning Threshold | Critical Threshold (Alert) | Action Required |
|--------|-------------------|----------------------------|-----------------|
| `dify-api` RAM | > 1.5 GB (75%) | > 1.8 GB (90%) | Restart container or scale out |
| OOM Kills | > 0 | > 1 in 24h | Increase `mem_limit` for that container |
| pgvector Size | > 5 GB | > 10 GB | Increase Postgres RAM to keep index in memory |
| 502/504 Errors | > 2 per minute | > 10 per minute | Concurrency limit hit — Dify queue is full |

## 8. Scaling Strategy

When the platform actually hits the 100 concurrent user wall, Docker Compose on a single VM is no longer sufficient. Follow this scaling path:

### Step 1: Vertical Scaling (Easiest)
If the host has 32+ GB of RAM, simply increase the memory and CPU limits in `docker-compose.prod.yml` for the bottlenecked container.

### Step 2: Container Replicas via Docker Compose (Moderate)

Docker Compose supports running multiple replicas of containers, but you must follow specific rules to avoid breaking the platform.

#### Rule 1: Only Scale Stateless Containers
You can scale `workflow-service`, `api-gateway`, `web`, `dify-api`, and `dify-worker`.
**DO NOT scale stateful containers:** `postgres`, `redis`, `rabbitmq`, `opensearch`, `minio`, `vault`. Scaling databases in Docker Compose will corrupt data.

#### Rule 2: Remove Host Port Bindings
If a container maps a port to the host (e.g., `ports: - "4001:4001"`), you **must** remove it. If you don't, Docker will fail to start the second replica with a "port already in use" error.
```yaml
  workflow-service:
    # REMOVE: ports: - "4001:4001"
    deploy:
      replicas: 3
```

#### Rule 3: Internal DNS Load Balancing (Zero Code Changes)
Once you add replicas, Docker's internal DNS automatically resolves the service name to a round-robin IP list of all running replicas.
- If `api-gateway` calls `http://workflow-service:4001`, this requires **zero code changes** — Docker handles the load balancing automatically across all replicas.

#### Rule 4: Route External Traffic Through Nginx
Because you removed the host port bindings in Rule 2, external access will break unless routed through a load balancer.
- All external traffic must go through `web-ingress` (Nginx). Nginx will use the internal Docker DNS to reach the replicas.

**Example: Scaling `dify-api` to 3 replicas**
1. Remove `ports: - "5001:5001"` from `dify-api`.
2. Add `deploy: replicas: 3` to `dify-api`.
3. Configure `web-ingress` to proxy `/dify-api/` to `http://dify-api:5001`.
4. Update `DIFY_PUBLIC_API_URL` to point to the Nginx endpoint.

### Step 3: Kubernetes / Swarm (Hard)
Move off Docker Compose to a container orchestrator (Kubernetes). Deploy stateless apps as Deployments with Horizontal Pod Autoscalers (HPA), and move stateful apps (Postgres, Redis) to managed cloud services (e.g., AWS RDS, ElastiCache).

## 9. Implementation Checklist

- [ ] Create `GET /admin/health/capacity` endpoint in `workflow-service`.
- [ ] Write script to collect Docker container RAM/CPU stats securely.
- [ ] Add pgvector size estimation query to Dify DB connection.
- [ ] Build `CapacityHealthPanel` React component in the admin web UI.
- [ ] Add Slack alerting webhooks for >90% RAM usage on `dify-api`.
- [ ] Document the Step 1 vertical scaling procedure in `docs/operations/platform-operations.md`.
