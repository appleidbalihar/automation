#!/usr/bin/env bash
# scripts/build-images.sh
#
# Build platform Docker images in dependency-aware phases.
# Mirrors the phased startup approach from platform-containers.sh.
#
# PHASE ORDER:
#   Phase 1: db-migrate  (Dockerfile.migrate — standalone, no shared base)
#   Phase 2: Backend services (Dockerfile.service shared base — workflow-service,
#            logging-service, api-gateway all share the same image layer)
#   Phase 3: web  (Dockerfile.web — requires NEXT_PUBLIC_* build args baked in)
#
# Usage:
#   scripts/build-images.sh dev              # build all phases for dev
#   scripts/build-images.sh prod             # build all phases for prod
#   scripts/build-images.sh dev --phase 3    # build only from phase 3 onward
#   scripts/build-images.sh dev --only web   # build a single service by name
#   scripts/build-images.sh dev --no-cache   # pass --no-cache to docker compose build

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,19p' "$0" >&2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

ENVIRONMENT="$1"
shift

if [[ "${ENVIRONMENT}" != "dev" && "${ENVIRONMENT}" != "prod" ]]; then
  echo "ERROR: environment must be 'dev' or 'prod'" >&2
  usage
  exit 1
fi

START_PHASE=1
ONLY_SERVICE=""
EXTRA_BUILD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)
      START_PHASE="${2:?--phase requires a number}"
      shift 2
      ;;
    --only)
      ONLY_SERVICE="${2:?--only requires a service name}"
      shift 2
      ;;
    --no-cache)
      EXTRA_BUILD_ARGS+=(--no-cache)
      shift
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "${ENVIRONMENT}" == "prod" ]]; then
  BASE_ENV_FILE=".env.production"
  OVERRIDE_FILE="docker-compose.prod.yml"
else
  BASE_ENV_FILE=".env"
  OVERRIDE_FILE="docker-compose.dev.yml"
fi

# Compose command — no runtime secrets needed for builds, so use placeholder env
DOCKER_COMPOSE=(
  docker compose
  -f "${ROOT_DIR}/docker-compose.yml"
  -f "${ROOT_DIR}/${OVERRIDE_FILE}"
  --env-file "${ROOT_DIR}/${BASE_ENV_FILE}"
)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')] ✅ $*${NC}"; }
info() { echo -e "${BLUE}[$(date '+%H:%M:%S')] ℹ️  $*${NC}"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] ⚠️  $*${NC}"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ❌ $*${NC}"; exit 1; }

build() {
  local label="$1"
  shift
  info "Building: $*"
  "${DOCKER_COMPOSE[@]}" build "${EXTRA_BUILD_ARGS[@]}" "$@"
  log "${label} built successfully"
}

# ---------------------------------------------------------------------------
# Single-service shortcut
# ---------------------------------------------------------------------------
if [[ -n "${ONLY_SERVICE}" ]]; then
  info "Building single service: ${ONLY_SERVICE}"
  build "${ONLY_SERVICE}" "${ONLY_SERVICE}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Phased build
# ---------------------------------------------------------------------------

phase1() {
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  info "PHASE 1: DB Migration image (Dockerfile.migrate)"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  build "db-migrate" db-migrate
}

phase2() {
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  info "PHASE 2: Backend services (shared Dockerfile.service base)"
  info "  workflow-service  logging-service  api-gateway"
  info "  (all share the same image layer — built in parallel)"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  # Build one service first so the shared base layer is cached,
  # then the remaining two hit the cache and finish quickly.
  build "api-gateway (primes shared base)" api-gateway
  build "workflow-service + logging-service" workflow-service logging-service
}

phase3() {
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  info "PHASE 3: Web frontend (Dockerfile.web — NEXT_PUBLIC_* baked in)"
  info "  Reads NEXT_PUBLIC_PLATFORM_URL and OAUTH_CALLBACK_BASE_URL"
  info "  from ${BASE_ENV_FILE} via docker-compose build args"
  info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  build "web" web
}

info "============================================================"
info "RapidRAG — Phased Image Build"
info "Environment : ${ENVIRONMENT}"
info "Base env    : ${BASE_ENV_FILE}"
info "Starting from phase: ${START_PHASE}"
[[ ${#EXTRA_BUILD_ARGS[@]} -gt 0 ]] && info "Extra args  : ${EXTRA_BUILD_ARGS[*]}"
info "============================================================"

[[ "${START_PHASE}" -le 1 ]] && phase1
[[ "${START_PHASE}" -le 2 ]] && phase2
[[ "${START_PHASE}" -le 3 ]] && phase3

info "============================================================"
log "ALL PHASES COMPLETE — images are ready"
info "Next step: scripts/platform-containers.sh ${ENVIRONMENT} start"
info "============================================================"
