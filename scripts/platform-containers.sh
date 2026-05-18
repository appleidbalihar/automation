#!/usr/bin/env bash
# scripts/platform-containers.sh
#
# Start, stop, restart, and inspect dev/prod Docker Compose services safely.
# For start/restart actions, this script generates a short-lived runtime env
# file from Vault and shreds it immediately after docker compose returns.
# For stop/status/logs/down, it uses real runtime env if Vault is available and
# otherwise falls back to placeholder values so Compose can parse quietly.
#
# Usage:
#   scripts/platform-containers.sh dev start              # full phased cold boot
#   scripts/platform-containers.sh dev start --phase 5    # resume from phase 5
#   scripts/platform-containers.sh dev restart workflow-service api-gateway web web-ingress
#   scripts/platform-containers.sh prod stop workflow-service
#   scripts/platform-containers.sh prod status
#
# Actions:
#   start    phased startup (all 6 phases) when no services given;
#            docker compose up -d [services...] when services are specified
#   restart  docker compose up -d --force-recreate [services...]
#   stop     docker compose stop [services...]
#   down     docker compose down
#   status   docker compose ps
#   logs     docker compose logs --tail=200 [services...]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,25p' "$0" >&2
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

ENVIRONMENT="$1"
ACTION="$2"
shift 2

if [[ "${ENVIRONMENT}" != "dev" && "${ENVIRONMENT}" != "prod" ]]; then
  echo "ERROR: environment must be 'dev' or 'prod'" >&2
  usage
  exit 1
fi

case "${ACTION}" in
  start|restart|stop|down|status|logs) ;;
  *)
    echo "ERROR: action must be one of: start, restart, stop, down, status, logs" >&2
    usage
    exit 1
    ;;
esac

if [[ "${ENVIRONMENT}" == "prod" ]]; then
  BASE_ENV_FILE=".env.production"
  OVERRIDE_FILE="docker-compose.prod.yml"
else
  BASE_ENV_FILE=".env"
  OVERRIDE_FILE="docker-compose.dev.yml"
fi

COMPOSE_FILE_ARGS=(
  -f "${ROOT_DIR}/docker-compose.yml"
  -f "${ROOT_DIR}/${OVERRIDE_FILE}"
)

RUNTIME_ENV_FILE="/run/platform-secrets/.env.${ENVIRONMENT}.runtime"

cleanup_runtime_env() {
  if [[ -f "${RUNTIME_ENV_FILE}" ]]; then
    shred -u "${RUNTIME_ENV_FILE}" >/dev/null 2>&1 || rm -f "${RUNTIME_ENV_FILE}"
  fi
}

needs_runtime_env() {
  return 0
}

run_compose() {
  (cd "${ROOT_DIR}" && docker compose \
    --env-file "${ROOT_DIR}/${BASE_ENV_FILE}" \
    --env-file "${RUNTIME_ENV_FILE}" \
    "${COMPOSE_FILE_ARGS[@]}" \
    "$@")
}

if needs_runtime_env; then
  mkdir -p "$(dirname "${RUNTIME_ENV_FILE}")"
  trap cleanup_runtime_env EXIT
  if ! ENVIRONMENT="${ENVIRONMENT}" OUTPUT_FILE="${RUNTIME_ENV_FILE}" bash "${ROOT_DIR}/scripts/generate-runtime-env.sh"; then
    if [[ "${ACTION}" == "start" || "${ACTION}" == "restart" ]]; then
      exit 1
    fi
    cat > "${RUNTIME_ENV_FILE}" <<'EOF'
POSTGRES_USER=placeholder
POSTGRES_PASSWORD=placeholder
POSTGRES_DB=automation
DATABASE_URL=postgresql://placeholder:placeholder@postgres:5432/automation
REDIS_PASSWORD=placeholder
REDIS_URL=redis://redis:6379
RABBITMQ_DEFAULT_USER=placeholder
RABBITMQ_DEFAULT_PASS=placeholder
RABBITMQ_URL=amqp://placeholder:placeholder@rabbitmq:5672
OPENSEARCH_INITIAL_ADMIN_PASSWORD=placeholder
OPENSEARCH_URL=http://opensearch:9200
MINIO_ACCESS_KEY=placeholder
MINIO_SECRET_KEY=placeholder
KEYCLOAK_ADMIN_PASSWORD=placeholder
KEYCLOAK_ADMIN_USERNAME=admin
KEYCLOAK_CLIENT_SECRET=placeholder
PLATFORM_OAUTH_SECRET=placeholder
DIFY_SECRET_KEY=placeholder
DIFY_DB_PASSWORD=placeholder
DIFY_REDIS_PASSWORD=placeholder
N8N_ENCRYPTION_KEY=placeholder
N8N_DB_PASSWORD=placeholder
N8N_WEBHOOK_TOKEN=placeholder
EOF
  fi
fi

case "${ACTION}" in
  start)
    if [[ $# -eq 0 ]]; then
      # Full cold boot — use phased startup for correct dependency order
      # (Vault → agents → infra → migrations → services → gateway)
      cleanup_runtime_env  # phased-startup.sh manages its own runtime env
      ENVIRONMENT="${ENVIRONMENT}" exec bash "${ROOT_DIR}/infra/scripts/phased-startup.sh" "$@"
    else
      run_compose up -d "$@"
    fi
    ;;
  restart)
    run_compose up -d --force-recreate "$@"
    ;;
  stop)
    run_compose stop "$@"
    ;;
  down)
    if [[ $# -gt 0 ]]; then
      echo "ERROR: down does not accept service names. Use stop for selected services." >&2
      exit 1
    fi
    if systemctl is-active --quiet rapidrag 2>/dev/null; then
      echo "Service is managed by systemd — stopping via: systemctl stop rapidrag"
      exec sudo systemctl stop rapidrag
    else
      run_compose down
    fi
    ;;
  status)
    run_compose ps "$@"
    ;;
  logs)
    run_compose logs --tail=200 "$@"
    ;;
esac
