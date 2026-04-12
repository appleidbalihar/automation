#!/usr/bin/env sh
set -eu

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <registry-image-prefix> <tag>" >&2
  exit 1
fi

REGISTRY_IMAGE_PREFIX="$1"
TAG="$2"

mirror() {
  src="$1"
  dst_name="$2"
  dst="${REGISTRY_IMAGE_PREFIX}/${dst_name}:${TAG}"
  dst_latest="${REGISTRY_IMAGE_PREFIX}/${dst_name}:latest"

  echo "Mirroring ${src} -> ${dst}"
  docker pull "${src}"
  docker tag "${src}" "${dst}"
  docker tag "${src}" "${dst_latest}"
  docker push "${dst}"
  docker push "${dst_latest}"
}

mirror "ankane/pgvector:latest" "infra-pgvector"
mirror "redis:7-alpine" "infra-redis"
mirror "rabbitmq:3-management" "infra-rabbitmq"
mirror "opensearchproject/opensearch:2.14.0" "infra-opensearch"
mirror "minio/minio:latest" "infra-minio"
mirror "quay.io/keycloak/keycloak:25.0" "infra-keycloak"
mirror "hashicorp/vault:1.17" "infra-vault"
mirror "nginx:1.27-alpine" "infra-nginx"
mirror "docker:27-cli" "infra-docker-cli"
