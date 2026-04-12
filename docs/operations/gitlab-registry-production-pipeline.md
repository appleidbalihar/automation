# Production Deployment From GitLab Registry

## Purpose
Production has no internet access. All runtime images must be pulled from GitLab Container Registry.

## First-Time Setup
1. Ensure GitLab project registry is enabled for:
- `registry.gitlab.com/appleid.balihar-group/automation`

2. Run CI pipeline on the target branch/tag.
- This publishes app images and mirrored infra images.

3. On production host:
- Clone this repository.
- Copy `.env.production.example` to `.env.production`.
- Set:
  - `REGISTRY_IMAGE_PREFIX`
  - `APP_IMAGE_TAG`
  - `INFRA_IMAGE_TAG`
  - all runtime secrets

## Registry Login On Production
Use a deploy token or personal access token with `read_registry`:

```bash
docker login registry.gitlab.com -u <gitlab-user-or-deploy-user> -p <token>
```

## Deploy Commands
```bash
docker compose --env-file .env.production -f docker-compose.prod.yml pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

## Verify
```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=100 api-gateway web keycloak
```

## Upgrade
1. Update `APP_IMAGE_TAG` and `INFRA_IMAGE_TAG` to a new commit SHA/tag.
2. Pull and restart:
```bash
docker compose --env-file .env.production -f docker-compose.prod.yml pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

## Rollback
Set image tags back to previous known-good SHA and run pull/up again.
