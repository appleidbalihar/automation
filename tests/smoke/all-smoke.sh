#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Running smoke:vault..."
bash "${REPO_ROOT}/tests/smoke/vault-integration-smoke.sh"

echo "Running smoke:rag..."
bash "${REPO_ROOT}/tests/smoke/rag-gateway-worker-smoke.sh"

echo "Running smoke:recovery..."
bash "${REPO_ROOT}/tests/smoke/order-recovery-timeline-smoke.sh"

echo "Running smoke:rbac..."
bash "${REPO_ROOT}/tests/smoke/rbac-resume-e2e-smoke.sh"

echo "Running smoke:engine..."
bash "${REPO_ROOT}/tests/smoke/execution-engine-smoke.sh"

echo "All smoke suites passed."
