# Build Optimization Plan

**Date:** 2026-05-12
**Author:** Platform Engineering
**Status:** Pending Implementation

---

## Overview

Analysis of why `turbo run build` is slow and a ranked action plan to fix it. The monorepo uses Turborepo + pnpm workspaces with 7 shared packages and 4 apps. Currently every build is a near-full rebuild due to missing incremental TypeScript configuration and a stale Turbo cache.

---

## Root Causes

### 1. No TypeScript Incremental Builds for Packages (Highest Impact)

All 7 packages (`auth`, `config`, `contracts`, `db`, `observability`, `tls-runtime`, `ui-kit`) use plain `tsc -p tsconfig.json` with no `incremental: true` and no `composite: true`.

**Effect:** Every build re-compiles every package from scratch. No `.tsbuildinfo` files are written for packages, so TypeScript cannot skip unchanged packages. Only `apps/web` has incremental TS via Next.js — nothing else does.

---

### 2. Turbo Local Cache is Stale / Cold

`.turbo/cache/` contains only ~30 entries last written on **2026-04-18** (3+ weeks old). Turbo's cache key is based on file content hashes — once the cache is cold or missing, every task reruns in full regardless of whether the source changed.

**Effect:** On any fresh checkout, CI run, or after cache expiry, the full build always runs from zero.

---

### 3. `workflow-service/src/main.ts` is a 6,009-line Monolith

The entire workflow service backend lives in a single 6009-line file. TypeScript must parse, bind, and typecheck the whole file as one unit — it cannot partially skip it.

**Effect:** This single file alone accounts for an estimated 2–4 seconds of TypeScript compile time per build.

---

### 4. `declarationMap: true` + `sourceMap: true` in Base tsconfig

`tsconfig.base.json` enables both `declarationMap` and `sourceMap` globally. Every `.ts` source file produces **3 output files**: `.js`, `.d.ts.map`, `.js.map`.

**Effect:** ~3× more I/O than necessary during builds. Sourcemaps are only useful for debugging — not needed in production CI builds.

---

### 5. No TypeScript Project References

No package tsconfig uses `references: [...]` to declare inter-package dependencies. TypeScript project references enable the compiler to skip recompiling a package if its inputs haven't changed, even across package boundaries.

**Effect:** TypeScript recompiles the full dependency graph on every invocation, even when only one package changed.

---

## Fix Plan (Ranked by Impact vs Effort)

| # | Fix | Effort | Expected Speedup |
|---|-----|--------|-----------------|
| 1 | Add `incremental: true` to all package tsconfigs | 10 min | ~40–60% after first run |
| 2 | Enable Turbo remote cache (`turbo link`) | 5 min | ~80% on CI / cold machines |
| 3 | Add `composite: true` + TS project references | 30 min | Proper cross-package skip |
| 4 | Split `workflow-service/src/main.ts` into modules | 2–4 hrs | Smaller incremental units |
| 5 | Disable `declarationMap`/`sourceMap` for prod builds | 5 min | ~5–10% I/O reduction |

---

## Implementation Checklist

### Step 1 — Add `incremental: true` to All Package tsconfigs

Add to each of the following files under `compilerOptions`:

```json
"incremental": true
```

Files to update:
- [ ] `packages/auth/tsconfig.json`
- [ ] `packages/config/tsconfig.json`
- [ ] `packages/contracts/tsconfig.json`
- [ ] `packages/db/tsconfig.json`
- [ ] `packages/observability/tsconfig.json`
- [ ] `packages/tls-runtime/tsconfig.json`
- [ ] `packages/ui-kit/tsconfig.json`
- [ ] `apps/api-gateway/tsconfig.json`
- [ ] `apps/workflow-service/tsconfig.json` (if exists)
- [ ] `apps/logging-service/tsconfig.json` (if exists)

Also add `"tsBuildInfoFile": "dist/.tsbuildinfo"` so the cache file lands in `dist/` (already in `.gitignore`).

---

### Step 2 — Enable Turbo Remote Cache

```bash
npx turbo link
```

This connects the local Turborepo to Vercel's free remote cache. After linking, every task hash that hits the cache will be restored from the remote instead of rerunning — this is the single biggest win for CI and fresh checkouts.

Add to `turbo.json` to ensure cache inputs are precise:

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"],
      "inputs": ["src/**", "tsconfig.json", "package.json"]
    }
  }
}
```

- [ ] Run `npx turbo link` and authenticate
- [ ] Add `inputs` to `turbo.json` build task
- [ ] Verify cache hit on second `turbo run build`

---

### Step 3 — Add `composite: true` + TypeScript Project References

`composite: true` is required for TypeScript project references. It forces output declarations and enables the compiler to use `.tsbuildinfo` to skip unchanged packages.

For each package tsconfig, add:
```json
"composite": true
```

Then in each **app** tsconfig (`api-gateway`, `workflow-service`, `logging-service`), add a `references` block:
```json
{
  "references": [
    { "path": "../../packages/auth" },
    { "path": "../../packages/config" }
    // ... only the packages this app actually imports
  ]
}
```

- [ ] Add `composite: true` to all 7 package tsconfigs
- [ ] Wire `references` in `apps/api-gateway/tsconfig.json`
- [ ] Wire `references` in `apps/workflow-service/tsconfig.json`
- [ ] Wire `references` in `apps/logging-service/tsconfig.json`
- [ ] Switch app build scripts from `tsc -p tsconfig.json` to `tsc -b tsconfig.json` (`-b` = build mode, honours references)

---

### Step 4 — Split `workflow-service/src/main.ts`

`apps/workflow-service/src/main.ts` is 6009 lines. Suggested module split:

| New file | Responsibility |
|----------|---------------|
| `src/routes/rag.ts` | KB / integration / sync routes |
| `src/routes/slack.ts` | Slack deployment + event routes |
| `src/routes/channels.ts` | Channel history routes |
| `src/routes/admin.ts` | Secrets, cert, admin routes |
| `src/services/dify.ts` | Dify API client logic |
| `src/services/slack-bot.ts` | Slack Web API calls |
| `src/server.ts` | Fastify app setup + hooks |
| `src/main.ts` | Entry point only — imports & starts server |

- [ ] Extract route groups into separate files
- [ ] Extract Dify client logic
- [ ] Extract Slack bot service
- [ ] Verify `tsc` still passes after split
- [ ] Confirm `turbo run build` shows per-module incremental speedup

---

### Step 5 — Disable sourcemaps for Production Builds

Override `sourceMap` and `declarationMap` for production in each package/app tsconfig:

```json
"sourceMap": false,
"declarationMap": false
```

Or use a separate `tsconfig.build.json` that extends the base and disables them:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "sourceMap": false,
    "declarationMap": false
  }
}
```

Then update build scripts: `"build": "tsc -p tsconfig.build.json"`

- [ ] Create `tsconfig.build.json` overrides for each package/app
- [ ] Update `package.json` build scripts to use `tsconfig.build.json`
- [ ] Keep `sourceMap: true` in base for IDE / dev experience

---

## Success Criteria

- [ ] `turbo run build` (warm cache) completes in **under 10 seconds**
- [ ] `turbo run build` (cold cache, no source changes since last build) completes in **under 30 seconds** via remote cache restore
- [ ] `tsc --version` reports no errors after all tsconfig changes
- [ ] `.tsbuildinfo` files exist in each `packages/*/dist/` after build
- [ ] Turbo dashboard shows cache HIT rate > 80% on repeated builds
