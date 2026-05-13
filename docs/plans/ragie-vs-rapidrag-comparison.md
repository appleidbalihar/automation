# RapidRAG vs Ragie.ai — Competitive Comparison

**Date:** 2026-05-13  
**Purpose:** Honest gap analysis and positioning for the RapidRAG platform against Ragie.ai

---

## TL;DR

RapidRAG is a **self-hosted, developer-owned, privacy-first RAG platform** with a full compliance controls stack and deep Vault-based secrets management. Ragie.ai is a **hosted SaaS developer API** that competes on ease of integration speed and multimodal document parsing. We are not the same product for the same buyer — but there are capability gaps worth closing.

---

## Feature Comparison Matrix

| Capability | RapidRAG | Ragie.ai |
|---|---|---|
| **Deployment** | Self-hosted (Docker Compose, on-prem, VPC-ready) | SaaS cloud; VPC + on-prem for Enterprise |
| **Retrieval** | Hybrid (vector + BM25) via Dify/pgvector | Hybrid (vector + keyword + summary indexing) |
| **Re-ranking** | ✅ Configurable per KB (Top-K + score threshold) | ✅ LLM re-ranking built-in |
| **Multi-KB fanout** | ✅ Fan-out to N KBs in one query, labeled answers | ❌ Single-partition queries |
| **Multi-tenancy** | ✅ User-level ownership + explicit sharing model | ✅ Partitioning for data isolation |
| **Document Sources** | GitHub, GitLab, Google Drive, web crawl, file upload | Google Drive, Notion, Confluence, Slack + embedded connectors |
| **File types** | Text, Markdown, code files, YAML, JSON, HTML, PDF | Text, PDFs, images, audio, video |
| **Multimodal (images/audio/video)** | ❌ Not supported | ✅ Agentic OCR with bounding boxes |
| **Entity extraction** | ❌ Not supported | ✅ Custom extraction via plain language |
| **Agentic retrieval / MCP server** | ❌ Not supported | ✅ MCP Server integration, agentic multi-step |
| **Scheduled sync** | ⚠️ UI available, cron execution not yet active | ✅ Webhooks + connectors auto-sync |
| **PII redaction pre-ingestion** | ✅ Active (regex NER in n8n pre-Dify upload) | ❌ Not documented |
| **Output gating / output validation** | ✅ Active (API key, prompt-injection scan) | ❌ Not documented |
| **Post-retrieval authorization** | ✅ Active (re-check on every message) | ❌ Not documented |
| **Answer quality scoring (faithfulness / relevance)** | ✅ Async RAGAS-style eval per response | ❌ Not documented |
| **Distributed tracing (traceId)** | ✅ End-to-end per request via AsyncLocalStorage | ❌ Not documented |
| **PII-safe logging** | ✅ Recursive PII masking before log storage | ❌ Not documented |
| **Secrets management** | ✅ HashiCorp Vault KV + PKI, mTLS, hot cert rotation | ✅ AES-256 at rest, TLS in transit |
| **SOC 2 / GDPR / HIPAA** | ⚠️ Controls active; formal audit not yet run | ✅ SOC 2 Type II, GDPR, HIPAA, CCPA certified |
| **Identity / RBAC** | ✅ Keycloak OIDC, 5 roles, per-KB access | ❌ API-key based; no documented RBAC |
| **Slack integration** | ✅ Bot with slash commands, per-user HMAC auth | ✅ Native connector (data ingestion) |
| **Custom system prompts per KB** | ✅ Template library, per-KB application via AI settings | ❌ Not a platform UI feature |
| **Per-KB retrieval tuning** | ✅ Top-K, score threshold, hybrid toggle per KB | ❌ Global settings only (via API) |
| **Developer API** | ⚠️ Internal REST; no public SDK | ✅ Full REST API + SDKs |
| **Uptime SLA** | ❌ No SLA (single-node, no HA) | ✅ 99.9%+ SLA |
| **Horizontal scaling / HA** | ❌ Single-node Docker Compose (K8s on roadmap) | ✅ Managed cloud, auto-scales |
| **Alerting** | ❌ Not yet (roadmap M8) | ✅ Webhooks |
| **Free tier** | ✅ Self-host = zero SaaS cost | ✅ Free developer tier |
| **Pricing model** | Infrastructure cost only (self-hosted) | Subscription SaaS tiers |

---

## Where We're Ahead

### 1. Privacy & Compliance Controls Depth
We have **six production-verified controls** (H1–H6) that Ragie does not advertise:
- PII redaction *before* vectors are written (not after)
- Output gating that scans every LLM response for secrets and injection markers
- Post-retrieval re-authorization on every message (revoked access takes effect immediately)
- Async RAGAS-style faithfulness + relevance scoring per message
- End-to-end distributed tracing with `traceId` propagated across the full pipeline
- Recursive PII masking in all structured logs before persistence

This is a genuine enterprise differentiator. Ragie SOC 2 certification addresses *infrastructure* compliance; we address *data pipeline* compliance.

### 2. Code Repository Indexing
GitHub + GitLab integration is native and purpose-built. Ragie supports Notion, Confluence, and Slack — document collaboration tools, not codebases. For teams that want to ask questions about their code, runbooks, and IaC, we have no equivalent competitor in Ragie.

### 3. Multi-KB Fan-Out Chat
Ragie is single-partition per query. We query N knowledge bases in parallel and return labeled answers per KB in one chat turn. This is architecturally unique and valuable for cross-team knowledge discovery.

### 4. Identity & RBAC
Keycloak gives us a full OIDC identity layer with 5 RBAC roles and per-KB sharing. Ragie uses API keys. Any enterprise with SSO requirements will need what we already have.

### 5. Deployment Sovereignty
Full on-prem, air-gapped capable (all images pre-pulled, LLM API configurable). Ragie's on-prem option is Enterprise-tier/custom. We give this to anyone who runs Docker.

### 6. Per-KB Prompt & Retrieval Tuning via UI
Operators can tune Top-K, score threshold, hybrid mode, and system prompt template per knowledge base through the UI. Ragie's retrieval configuration is code/API-level only.

---

## Where Ragie Is Ahead

### 1. Multimodal Document Parsing (Critical Gap)
Ragie's **Agentic OCR** handles images, audio, video, tables, forms, charts, and bounding boxes. We index only text-based files. Any customer with PDFs containing embedded tables, scanned documents, or non-text content will see much better results in Ragie.

**Recommendation:** Integrate a document parsing layer (Apache Tika, Unstructured.io, or LlamaParse) as a pre-processing step before Dify ingestion. This is a medium-effort addition to the n8n sync workflow.

### 2. Entity Extraction
Ragie can pull structured data out of documents via natural-language entity descriptions. We have no equivalent. This closes the gap between RAG and structured data extraction.

**Recommendation:** Explore a LLM-based extraction pass in n8n for high-value KB types (contracts, tickets, changelogs).

### 3. Agentic Retrieval & MCP Server
Ragie exposes an MCP Server endpoint so AI agents can use retrieval as a tool. We are a chat interface, not an agentic API. As agentic AI workflows mature, this is a positioning risk.

**Recommendation:** Expose workflow-service as an MCP-compatible tool endpoint. This is a low-effort wrapper on existing retrieval logic.

### 4. Formal Compliance Certification (SOC 2, HIPAA)
Ragie is certified. We have the controls but no audit. Any enterprise procurement will ask for this.

**Recommendation:** Run a SOC 2 Type II readiness assessment. Controls H1–H6 are already in place — the gap is documentation and an auditor.

### 5. High Availability & SLA
Ragie offers 99.9%+ SLA. We are single-node with no HA, no autoscaling, no alerting. For production workloads with SLA requirements, this is a blocker.

**Recommendation:** K8s migration (roadmap M7) + alerting (roadmap M8) are the right path. In the interim, document the expected single-node reliability posture clearly for customers.

### 6. Public Developer API + SDKs
Ragie's value proposition is "weeks of RAG infrastructure in an API call." We have no public SDK or documented API surface for external developers to build on top of.

**Recommendation:** If we want to offer RapidRAG as a platform (not just a product), document and version the workflow-service REST API and publish an OpenAPI spec.

### 7. Scheduled Sync / Auto-Connectors
Ragie's connectors auto-sync via webhooks. Our cron field exists in the UI but is not yet wired to a scheduler. Customers managing many KBs will feel this gap immediately.

**Recommendation:** This is a short implementation — wire the `schedule` field on `RagKnowledgeBase` to a cron job in workflow-service or n8n. High ROI, low effort.

---

## Positioning Summary

| Buyer | Choose RapidRAG | Choose Ragie.ai |
|---|---|---|
| Wants full data sovereignty / air-gap | ✅ | ❌ |
| GDPR/HIPAA data pipeline controls (not just infra) | ✅ | ❌ |
| Code repository Q&A (GitHub/GitLab) | ✅ | ❌ |
| Slack bot for internal team Q&A | ✅ | ⚠️ (only as data source) |
| Multimodal docs (PDFs with tables, scans, video) | ❌ | ✅ |
| Fast SaaS API integration for app developers | ❌ | ✅ |
| MCP / agentic AI tool use | ❌ | ✅ |
| Enterprise SSO + RBAC | ✅ | ❌ |
| SOC 2 certified (today) | ❌ | ✅ |
| HA / 99.9% SLA | ❌ | ✅ |

---

## Top 5 Recommended Actions (Priority Order)

1. **Wire scheduled sync** — highest user-visible gap, lowest effort. Estimated: 1–2 days.
2. **Add PDF/document parsing** (Unstructured.io or Tika in n8n pre-Dify) — opens multimodal content to indexing. Estimated: 3–5 days.
3. **Expose MCP tool endpoint** on workflow-service — future-proofs against agentic AI adoption. Estimated: 2–3 days.
4. **Publish OpenAPI spec** for workflow-service — enables external developers and positions RapidRAG as a platform. Estimated: 1–2 days.
5. **SOC 2 readiness assessment** — controls are already live; formal audit documentation is the remaining work. Timeline: 1–2 months with an auditor.
