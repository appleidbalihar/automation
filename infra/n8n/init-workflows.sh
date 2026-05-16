#!/bin/sh
# infra/n8n/init-workflows.sh
# Runs before n8n starts on every container boot.
# Imports the unified source-to-dify-sync workflow and ensures it is active.
# Idempotent — safe to run on every restart.
set -e

WORKFLOW_FILE="/home/node/workflows/source-to-dify-sync.json"
UNIFIED_ID="rag-sync-source-template"

# IDs of the old per-source workflows that were replaced by the unified flow.
LEGACY_IDS="c81ad5e4-7f92-4e07-a2d3-741534a0c16c 22d3d7b8-d94b-4300-a3a3-b55835e6c902"

if [ -f "${WORKFLOW_FILE}" ]; then
  echo "[n8n-init] Importing unified source-to-dify-sync workflow..."
  n8n import:workflow --input="${WORKFLOW_FILE}" 2>&1 || true

  echo "[n8n-init] Activating unified workflow (id=${UNIFIED_ID})..."
  n8n update:workflow --id="${UNIFIED_ID}" --active=true 2>&1 || true

  echo "[n8n-init] Deactivating legacy per-source workflows..."
  for id in ${LEGACY_IDS}; do
    n8n update:workflow --id="${id}" --active=false 2>&1 || true
  done
else
  echo "[n8n-init] WARNING: ${WORKFLOW_FILE} not found, skipping import."
fi

echo "[n8n-init] Done. Handing off to n8n..."
exec /docker-entrypoint.sh
