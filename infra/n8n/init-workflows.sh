#!/bin/sh
# infra/n8n/init-workflows.sh
# Runs as the container entrypoint.
# 1. Imports the unified workflow into the DB (idempotent).
# 2. Sets the workflow active=true in the DB via CLI before n8n starts.
# 3. Starts n8n (foreground) — n8n registers webhooks for active workflows at boot.
#
# Why CLI activation instead of REST API:
#   n8n import:workflow resets active=false in the DB on every import.
#   Setting active=true via CLI before starting ensures n8n registers the webhook
#   automatically at startup — no password, no race condition, survives every restart.
set -e

WORKFLOW_FILE="/home/node/workflows/source-to-dify-sync.json"
UNIFIED_ID="rag-sync-source-template"
LEGACY_IDS="c81ad5e4-7f92-4e07-a2d3-741534a0c16c 22d3d7b8-d94b-4300-a3a3-b55835e6c902"

# ── Step 1: Import workflow into DB before n8n starts ────────────────────────
if [ -f "${WORKFLOW_FILE}" ]; then
  echo "[n8n-init] Importing unified source-to-dify-sync workflow..."
  n8n import:workflow --input="${WORKFLOW_FILE}" 2>&1 || true

  echo "[n8n-init] Deactivating legacy per-source workflows (DB flag)..."
  for id in ${LEGACY_IDS}; do
    n8n update:workflow --id="${id}" --active=false 2>&1 || true
  done
else
  echo "[n8n-init] WARNING: ${WORKFLOW_FILE} not found, skipping import."
fi

# ── Step 2: Activate workflow in DB before n8n starts ────────────────────────
# import:workflow resets active=false; restore to true so n8n registers the
# webhook automatically when it boots in Step 3.
echo "[n8n-init] Setting workflow active in DB..."
n8n update:workflow --id="${UNIFIED_ID}" --active=true 2>&1 || \
  echo "[n8n-init] WARNING: Could not set workflow active via CLI — webhook may not register."

# ── Step 3: Start n8n (foreground) ───────────────────────────────────────────
# n8n reads active workflows from DB on startup and registers their webhooks.
echo "[n8n-init] Starting n8n (webhooks will register on startup)..."
exec /docker-entrypoint.sh
