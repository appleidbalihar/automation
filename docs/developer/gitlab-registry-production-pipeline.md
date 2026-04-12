# GitLab Registry Production Pipeline

## Goal
Build and publish both platform images and mirrored infrastructure images into GitLab Container Registry so production can deploy without internet access.

## Added Files
- `.gitlab-ci.yml`
- `ci/mirror-images.sh`
- `docker-compose.prod.yml`
- `.env.production.example`

## Pipeline Behavior
1. `verify:prod-compose`
- Resolves `docker-compose.prod.yml` with CI tag variables.

2. `build:app-images`
- Builds and pushes:
  - `platform-service`
  - `platform-web`
  - `platform-db-migrate`
- Tags pushed:
  - `${CI_COMMIT_SHA}`
  - `latest`

3. `mirror:infra-images`
- Pulls internet images in CI, re-tags, and pushes to GitLab:
  - `infra-pgvector`
  - `infra-redis`
  - `infra-rabbitmq`
  - `infra-opensearch`
  - `infra-minio`
  - `infra-keycloak`
  - `infra-vault`
  - `infra-nginx`
  - `infra-docker-cli`

## Production Compose Strategy
- `docker-compose.yml` remains unchanged for current environment.
- `docker-compose.prod.yml` is secure-only and references GitLab registry images only.
- App and infra images are independently taggable:
  - `APP_IMAGE_TAG`
  - `INFRA_IMAGE_TAG`

## Security Notes
- Do not hardcode tokens in repository files.
- Use GitLab protected CI variables:
  - `CI_REGISTRY_USER`
  - `CI_REGISTRY_PASSWORD`
  - Built-in `CI_REGISTRY` and `CI_REGISTRY_IMAGE`.
