#!/bin/bash
# Run this script after rebuilding the Docker images to update the Prisma client
# inside the running workflow-service container.
# This is needed because the Prisma generate step is cached in Docker build layers.

set -e

CONTAINER="09_automationplatform-workflow-service-1"

echo "Step 1: Copying updated schema.prisma into Prisma client..."
docker cp packages/db/prisma/schema.prisma \
  "${CONTAINER}:/app/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma/client/schema.prisma"
docker cp packages/db/prisma/schema.prisma \
  "${CONTAINER}:/app/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client/schema.prisma" 2>/dev/null || true

echo "Step 2: Regenerating Prisma client..."
docker exec "${CONTAINER}" sh -c "
cd /app &&
node node_modules/.pnpm/prisma@5.22.0/node_modules/prisma/build/index.js generate --schema=packages/db/prisma/schema.prisma 2>&1 | tail -3
"

echo "Step 3: Rebuilding @platform/db dist..."
docker exec "${CONTAINER}" sh -c "
cd /app/packages/db &&
node /app/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p tsconfig.json
"

echo "Step 4: Restarting workflow-service..."
docker compose restart workflow-service

echo "Done! Prisma client updated."
