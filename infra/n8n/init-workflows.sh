#!/bin/sh
# infra/n8n/init-workflows.sh
# Runs as the container entrypoint.
# 1. Imports the unified workflow into the DB (idempotent).
# 2. Starts n8n in the background.
# 3. Waits until n8n is healthy, then activates the workflow via REST API
#    so webhooks are actually registered in n8n's runtime (not just the DB flag).
# 4. Brings n8n back to the foreground.
set -e

WORKFLOW_FILE="/home/node/workflows/source-to-dify-sync.json"
UNIFIED_ID="rag-sync-source-template"
LEGACY_IDS="c81ad5e4-7f92-4e07-a2d3-741534a0c16c 22d3d7b8-d94b-4300-a3a3-b55835e6c902"
N8N_URL="http://localhost:5678"
N8N_EMAIL="${N8N_OWNER_EMAIL:-admin@platform.local}"
N8N_PASSWORD="${N8N_OWNER_PASSWORD:-}"

# ── Step 1: Import workflow into DB before n8n starts ─────────────────────────
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

# ── Step 2: Start n8n in background ──────────────────────────────────────────
echo "[n8n-init] Starting n8n in background..."
/docker-entrypoint.sh &
N8N_PID=$!

# ── Step 3: Wait for n8n to be ready, then activate via REST API ─────────────
echo "[n8n-init] Waiting for n8n to be ready..."
ATTEMPTS=0
MAX_ATTEMPTS=60
until wget -qO- "${N8N_URL}/healthz" 2>/dev/null | grep -q "ok"; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then
    echo "[n8n-init] WARNING: n8n did not become ready in time, skipping REST activation."
    wait $N8N_PID
    exit $?
  fi
  sleep 2
done
# Give REST API a moment to fully initialize after healthz passes
sleep 3
echo "[n8n-init] n8n is ready."

# Only attempt REST activation if we have a password configured
if [ -n "${N8N_PASSWORD}" ]; then
  echo "[n8n-init] Activating workflow via REST API (registers webhooks)..."
  cat > /tmp/n8n-activate.mjs << 'JSEOF'
const EMAIL = process.env.N8N_OWNER_EMAIL || 'admin@platform.local';
const PASSWORD = process.env.N8N_OWNER_PASSWORD || '';
const BASE = 'http://localhost:5678';
const WF_ID = 'rag-sync-source-template';

async function tryLogin(retries = 5) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(BASE + '/rest/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailOrLdapLoginId: EMAIL, password: PASSWORD })
    });
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    if (cookie.startsWith('n8n-auth=')) return cookie;
    const body = await res.text();
    if (i < retries - 1 && body.includes('DOCTYPE')) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    throw new Error('Login failed (' + res.status + '): ' + body.substring(0, 100));
  }
}

(async () => {
  try {
    const cookie = await tryLogin();
    const wfRes = await fetch(BASE + '/rest/workflows/' + WF_ID, { headers: { cookie } });
    const wf = (await wfRes.json()).data;
    const versionId = wf.versionId;

    await fetch(BASE + '/rest/workflows/' + WF_ID, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ active: false })
    });
    await new Promise(r => setTimeout(r, 1000));

    const activateRes = await fetch(BASE + '/rest/workflows/' + WF_ID + '/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ versionId })
    });
    const result = await activateRes.json();
    if (result.data && result.data.active) {
      console.log('[n8n-init] Workflow activated and webhook registered.');
    } else {
      console.error('[n8n-init] WARNING: activation response unexpected:', JSON.stringify(result).substring(0, 200));
    }
  } catch (e) {
    console.error('[n8n-init] WARNING: REST activation failed:', e.message);
  }
})();
JSEOF
  node /tmp/n8n-activate.mjs 2>&1
else
  echo "[n8n-init] N8N_OWNER_PASSWORD not set — skipping REST activation. Webhook may not be registered until manually activated in the UI."
fi

# ── Step 4: Wait for n8n (foreground) ────────────────────────────────────────
echo "[n8n-init] Done. Waiting for n8n process..."
wait $N8N_PID
