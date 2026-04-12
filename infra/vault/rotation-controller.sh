#!/usr/bin/env sh
set -eu

ROTATION_INTERVAL_SECONDS="${ROTATION_INTERVAL_SECONDS:-20}"
REQUESTS_FILE="${ROTATION_REQUESTS_FILE:-/rotation-control/requests.jsonl}"
ENABLE_FALLBACK_ROTATION="${ROTATION_ENABLE_FALLBACK:-false}"
TARGET_CONTAINERS="${TARGET_CONTAINERS:-postgres rabbitmq redis keycloak minio opensearch}"
RESTART_WINDOW_SECONDS="${RESTART_WINDOW_SECONDS:-1800}"

last_fallback_epoch=0

mkdir -p "$(dirname "$REQUESTS_FILE")"
touch "$REQUESTS_FILE"

log() {
  echo "[rotation-controller] $*"
}

restart_compose_service() {
  service_name="$1"
  container_names="$(docker ps --filter "label=com.docker.compose.service=${service_name}" --format '{{.Names}}' || true)"
  if [ -z "$container_names" ]; then
    log "no running containers found for service=${service_name}"
    return 0
  fi
  echo "$container_names" | while IFS= read -r name; do
    [ -z "$name" ] && continue
    log "restarting ${name} (service=${service_name})"
    docker restart "$name" >/dev/null 2>&1 || true
  done
}

process_request_line() {
  line="$1"
  [ -z "$line" ] && return 0
  request_id="$(echo "$line" | awk -F'|' '{print $1}')"
  service_name="$(echo "$line" | awk -F'|' '{print $2}')"
  trigger="$(echo "$line" | awk -F'|' '{print $3}')"
  requested_by="$(echo "$line" | awk -F'|' '{print $4}')"
  queued_at="$(echo "$line" | awk -F'|' '{print $5}')"
  targets_csv="$(echo "$line" | awk -F'|' '{print $6}')"

  if [ -z "$service_name" ]; then
    log "skipping malformed request_id=${request_id}"
    return 0
  fi

  log "processing request_id=${request_id} service=${service_name} trigger=${trigger} requested_by=${requested_by} queued_at=${queued_at}"

  if [ -z "$targets_csv" ]; then
    restart_compose_service "$service_name"
    return 0
  fi

  echo "$targets_csv" | tr ',' '\n' | while IFS= read -r target; do
    [ -z "$target" ] && continue
    restart_compose_service "$target"
  done
}

process_request_queue() {
  [ -s "$REQUESTS_FILE" ] || return 0
  tmp_file="$(mktemp /tmp/rotation-queue.XXXXXX)"
  cp "$REQUESTS_FILE" "$tmp_file"
  : > "$REQUESTS_FILE"

  while IFS= read -r line || [ -n "$line" ]; do
    process_request_line "$line"
  done < "$tmp_file"

  rm -f "$tmp_file"
}

maybe_run_fallback_rotation() {
  if [ "$ENABLE_FALLBACK_ROTATION" != "true" ]; then
    return 0
  fi
  now_epoch="$(date +%s)"
  if [ $((now_epoch - last_fallback_epoch)) -lt "$RESTART_WINDOW_SECONDS" ]; then
    return 0
  fi
  for service_name in $TARGET_CONTAINERS; do
    restart_compose_service "$service_name"
  done
  last_fallback_epoch="$now_epoch"
}

while true; do
  process_request_queue || true
  maybe_run_fallback_rotation || true
  sleep "$ROTATION_INTERVAL_SECONDS"
done

