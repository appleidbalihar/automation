#!/bin/bash
# =============================================================================
# Automation Platform — Phased Docker Compose Startup Script
# =============================================================================
#
# WHY THIS EXISTS:
# Starting all 33 containers simultaneously with 'docker compose up -d' causes:
#   - Disk I/O spikes from concurrent BoltDB writes (overlays + volumes)
#   - Postgres health check failures (postgres starts before its TLS cert is ready)
#   - Services starting before their dependencies are truly healthy
#
# THIS SCRIPT:
# Starts containers in 6 dependency-aware phases, waiting for critical gates
# between each phase. Containers within a phase start in parallel.
#
# STARTUP ORDER:
#   Phase 1: Core infrastructure (vault, opensearch, isolated DBs, sandbox)
#   Phase 2: Vault agents + cert controller (all need vault running)
#   Phase 3: Data stores + n8n + dify-migrate (need TLS certs from agents)
#   Phase 4: DB migrations + dify-api/worker (need postgres healthy)
#   Phase 5: Backend services + dify-web (need migrations complete)
#   Phase 6: API gateway + web frontend + nginx ingress (last mile)
#
# USAGE:
#   ./infra/scripts/phased-startup.sh           # start all phases
#   ./infra/scripts/phased-startup.sh --phase 3 # start from phase 3
# =============================================================================

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$COMPOSE_DIR"

# Color output for visibility in journalctl
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')] ✅ $*${NC}"; }
info() { echo -e "${BLUE}[$(date '+%H:%M:%S')] ℹ️  $*${NC}"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] ⚠️  $*${NC}"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ❌ $*${NC}"; exit 1; }

# Parse optional --phase argument to start from a specific phase
# Default to phase 1 (start everything) when called with no arguments (e.g. from systemd)
START_PHASE="${1:-1}"
if [[ "${1:-}" == "--phase" && -n "${2:-}" ]]; then
  START_PHASE="$2"
fi

# =============================================================================
# WAIT HELPERS
# =============================================================================

# Wait for a TCP port to be open (max wait_seconds)
wait_for_port() {
  local host="$1" port="$2" label="$3" max="${4:-120}"
  info "Waiting for $label ($host:$port) to be ready..."
  local elapsed=0
  while ! (echo > /dev/tcp/"$host"/"$port") 2>/dev/null; do
    sleep 3; elapsed=$((elapsed + 3))
    [[ $elapsed -ge $max ]] && err "Timeout waiting for $label after ${max}s"
  done
  log "$label is ready"
}

# Wait for a docker container to exit with success (for one-shot migrations)
wait_for_container_exit() {
  local container="$1" max="${2:-300}"
  info "Waiting for $container to complete..."
  local elapsed=0
  while true; do
    local status
    status=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "missing")
    local exit_code
    exit_code=$(docker inspect --format='{{.State.ExitCode}}' "$container" 2>/dev/null || echo "99")
    if [[ "$status" == "exited" ]]; then
      if [[ "$exit_code" == "0" ]]; then
        log "$container completed successfully"
        return 0
      else
        err "$container exited with code $exit_code — check logs: docker logs $container"
      fi
    fi
    sleep 3; elapsed=$((elapsed + 3))
    [[ $elapsed -ge $max ]] && err "Timeout waiting for $container after ${max}s"
  done
}

# Wait for postgres to be healthy via pg_isready inside the container
wait_for_postgres() {
  local container="${1:-09_automationplatform-postgres-1}" max="${2:-180}"
  info "Waiting for postgres to be healthy..."
  local elapsed=0
  while true; do
    local health
    health=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "unknown")
    [[ "$health" == "healthy" ]] && { log "Postgres is healthy"; return 0; }
    sleep 5; elapsed=$((elapsed + 5))
    [[ $elapsed -ge $max ]] && err "Postgres not healthy after ${max}s (status: $health)"
  done
}

# Wait for vault's HTTP port to be open (TCP check only — vault may be sealed/uninitialized)
# We just need the port to be listening before starting vault-agents.
# vault-bootstrap will handle initialization and unsealing.
# Using /dev/tcp TCP check (not curl) since vault returns 503 when sealed which fails curl -sf
wait_for_vault() {
  local max="${1:-120}"
  info "Waiting for Vault port :8200 to be open..."
  local elapsed=0
  while ! (echo > /dev/tcp/localhost/8200) 2>/dev/null; do
    sleep 3; elapsed=$((elapsed + 3))
    [[ $elapsed -ge $max ]] && err "Vault port :8200 not open after ${max}s"
  done
  log "Vault port is open (vault started)"
}

# Wait for vault-bootstrap to complete PKI setup (approle dir is created)
wait_for_vault_bootstrap() {
  local max="${1:-180}"
  info "Waiting for Vault PKI bootstrap to complete..."
  local elapsed=0
  while true; do
    # vault-bootstrap creates approle files; check if vault-bootstrap container is done
    # OR check if the approle directory exists in the vault_data volume
    local status
    status=$(docker inspect --format='{{.State.Status}}' 09_automationplatform-vault-bootstrap-1 2>/dev/null || echo "unknown")
    # vault-bootstrap runs in watch mode (restart: unless-stopped) so it stays running
    # We check if it has logged "Bootstrap complete" at least once
    if docker logs 09_automationplatform-vault-bootstrap-1 2>&1 | grep -q "PKI bootstrap complete\|PKI bootstrap already completed\|watch mode enabled"; then
      log "Vault PKI bootstrap complete"
      return 0
    fi
    sleep 5; elapsed=$((elapsed + 5))
    [[ $elapsed -ge $max ]] && { warn "Vault bootstrap check timed out — proceeding anyway"; return 0; }
  done
}

# =============================================================================
# PHASE DEFINITIONS
# =============================================================================

phase1() {
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  info "PHASE 1: Core Infrastructure (no dependencies)"
  info "  Starting: vault, opensearch, dify-db, dify-redis, n8n-db, dify-sandbox"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  docker compose up -d \
    vault \
    opensearch \
    dify-db \
    dify-redis \
    n8n-db \
    dify-sandbox

  log "Phase 1 containers started"

  # Gate: wait for vault to be ready before proceeding
  wait_for_vault 120
}

phase2() {
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  info "PHASE 2: Vault Bootstrap + All Vault Agents + Cert Controller"
  info "  Starting: vault-bootstrap, all *-vault-agent sidecars, cert-rotation-controller"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  docker compose up -d \
    vault-bootstrap \
    postgres-vault-agent \
    redis-vault-agent \
    rabbitmq-vault-agent \
    minio-vault-agent \
    keycloak-vault-agent \
    dify-api-vault-agent \
    n8n-vault-agent \
    workflow-service-vault-agent \
    logging-service-vault-agent \
    api-gateway-vault-agent \
    web-vault-agent \
    web-ingress-vault-agent \
    cert-rotation-controller

  log "Phase 2 containers started"

  # Gate: wait for vault-bootstrap to complete PKI setup
  # (TLS certs won't be issued until PKI is initialized)
  wait_for_vault_bootstrap 180
  # Extra buffer for vault-agents to fetch and write TLS certs to volumes
  info "Waiting 15s for vault-agents to issue TLS certs to volumes..."
  sleep 15
  log "TLS certs should be ready in volumes"
}

phase3() {
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  info "PHASE 3: Data Stores + n8n + Dify Migration"
  info "  Starting: postgres, redis, rabbitmq, minio, keycloak, n8n, dify-migrate"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  docker compose up -d \
    postgres \
    redis \
    rabbitmq \
    minio \
    keycloak \
    n8n \
    dify-migrate

  log "Phase 3 containers started"

  # Gate: wait for postgres to be healthy before running migrations
  # Postgres does WAL recovery on HDD which takes 90-120s. Use 300s timeout.
  wait_for_postgres 09_automationplatform-postgres-1 300
}

phase4() {
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  info "PHASE 4: Database Migrations + Dify API/Worker"
  info "  Starting: db-migrate (waits for healthy postgres)"
  info "  Then: dify-api, dify-worker (waits for dify-migrate)"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Run platform DB migration first
  docker compose up -d db-migrate
  wait_for_container_exit 09_automationplatform-db-migrate-1 180

  # Wait for dify-migrate to complete (started in phase 3 alongside postgres)
  # dify-migrate runs Flask DB upgrade which takes 9-12 minutes on this spinning HDD.
  # Observed times: first boot = 9m31s, second boot = 11m46s. Use 720s (12 minutes).
  wait_for_container_exit 09_automationplatform-dify-migrate-1 720

  # Now start dify-api and dify-worker (migrations are done)
  docker compose up -d dify-api dify-worker

  log "Phase 4 complete — migrations done, dify-api/worker starting"
}

phase5() {
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  info "PHASE 5: Backend Services + Dify Web"
  info "  Starting: workflow-service, logging-service, dify-web"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  docker compose up -d \
    workflow-service \
    logging-service \
    dify-web

  log "Phase 5 containers started"

  # Brief wait to let backend services bind their ports before api-gateway connects
  info "Waiting 10s for backend services to initialize..."
  sleep 10
}

phase6() {
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  info "PHASE 6: API Gateway + Web Frontend + Nginx Ingress"
  info "  Starting: api-gateway, web, web-ingress"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  docker compose up -d \
    api-gateway \
    web \
    web-ingress

  log "Phase 6 complete — platform is fully up"
}

# =============================================================================
# MAIN
# =============================================================================

info "============================================================"
info "Automation Platform — Phased Startup"
info "Working directory: $COMPOSE_DIR"
info "Starting from phase: $START_PHASE"
info "============================================================"

[[ "$START_PHASE" -le 1 ]] && phase1
[[ "$START_PHASE" -le 2 ]] && phase2
[[ "$START_PHASE" -le 3 ]] && phase3
[[ "$START_PHASE" -le 4 ]] && phase4
[[ "$START_PHASE" -le 5 ]] && phase5
[[ "$START_PHASE" -le 6 ]] && phase6

info "============================================================"
log "ALL PHASES COMPLETE — Automation Platform is running"
info "============================================================"
docker compose ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null | head -40 || true
