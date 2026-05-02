# Docker & Automation Platform — Production Boot Fix Runbook

**Version:** 1.0
**Date:** 2026-04-30
**Environment:** RHEL/CentOS 7, Docker 26.1.3, Spinning HDD, SELinux Enforcing
**Applies to:** Any server running the 09_automationplatform Docker Compose stack

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Root Cause Analysis](#2-root-cause-analysis)
3. [Solution Overview](#3-solution-overview)
4. [File Inventory](#4-file-inventory)
5. [Step-by-Step Implementation](#5-step-by-step-implementation)
6. [Verification](#6-verification)
7. [Monitoring After Reboot](#7-monitoring-after-reboot)
8. [Troubleshooting](#8-troubleshooting)
9. [Important Notes for AI / Future Engineers](#9-important-notes-for-ai--future-engineers)

---

## 1. Problem Statement

After every server reboot, the following symptoms appeared:

```
[root@localhost ~]# docker ps
^C   ← hangs indefinitely, must Ctrl+C

[root@localhost ~]# systemctl status automationplatform
● automationplatform.service
   Active: inactive (dead)
```

- `docker ps` hangs forever (no output, no error)
- `automationplatform` service shows `inactive (dead)` instead of `active`
- All 33 Docker containers are not running
- Manual intervention was required every reboot to start the platform

**This happened on every single server reboot** without exception.

---

## 2. Root Cause Analysis

### 2.1 Why `docker ps` Hangs

Docker uses **BoltDB** (an embedded key-value database) for storing runtime state. On every start, Docker opens these BoltDB files:

```
/home/bali/docker-data/network/files/local-kv.db   ← network topology state
/home/bali/docker-data/volumes/metadata.db          ← volume registry
/home/bali/docker-data/buildkit/containerdmeta.db   ← build cache
/home/bali/docker-data/buildkit/snapshots.db        ← snapshot metadata
```

BoltDB calls `fdatasync()` on every write to ensure journal integrity. On a **spinning HDD**, `fdatasync()` is a physical disk operation that can block for **minutes**. This blocks Docker's main goroutine (goroutine 1), making the Docker API socket unresponsive even though `dockerd` reports "Daemon has completed initialization".

**Timeline without fix:**
```
Boot → dockerd starts → "Daemon has completed initialization" (fast)
     → BoltDB fdatasync blocks goroutine 1 for 3-10 minutes
     → docker ps hangs (socket not accepting connections)
     → automationplatform service fails with dependency error
```

### 2.2 Why `automationplatform` Was `inactive (dead)`

The original service used `Requires=docker.service`. When systemd evaluates this dependency, it checks if docker is in `active` state — not `activating`. Since Docker stays in `activating` (BoltDB hang) for 3-10 minutes, systemd immediately fails automationplatform with:

```
Dependency failed for Automation Platform Docker Compose Stack
automationplatform.service: Job failed with result 'dependency'
```

This happens before the service even starts its ExecStartPre commands.

### 2.3 Why the BoltDB Files Cause Slow Startup

**`network/files/local-kv.db`:** After each reboot, this file contained stale network sandbox records from the previous session. Docker spent minutes trying to clean up these stale entries atomically, each operation requiring an fdatasync.

**`volumes/metadata.db`:** Docker rebuilds this file on each start. The initial write involves many fdatasync operations on the spinning HDD.

**`containers/` state files:** With `live-restore: false`, Docker tries to process all 33 saved container configs on startup, triggering additional I/O.

---

## 3. Solution Overview

The fix has **four components** that work together:

| Component | File | What it does |
|-----------|------|--------------|
| **A. Docker daemon config** | `/etc/docker/daemon.json` | Disables live-restore to prevent stale container re-attachment |
| **B. Pre-start cleanup + RAM disks** | `/etc/systemd/system/docker.service.d/pre-clean.conf` | Mounts tmpfs for BoltDB, wipes stale state before Docker starts |
| **C. Startup guard** | `/etc/systemd/system/docker.service.d/startup-guard.conf` | Adds restart-on-failure and timeout for Docker |
| **D. Platform service** | `/etc/systemd/system/automationplatform.service` | Self-polling Docker wait loop, phased startup script |
| **E. Phased startup script** | `infra/scripts/phased-startup.sh` | Starts 33 containers in 6 dependency-ordered phases |

**Key insight:** By mounting `network/files/` and `buildkit/` on tmpfs (RAM), Docker's BoltDB `fdatasync` completes in microseconds instead of minutes. By deleting `volumes/metadata.db` before start, Docker rebuilds this index fresh without slow disk operations. Result: **Docker responds to `docker ps` in ~4-10 seconds** instead of 3-10 minutes.

**Key insight 2:** By removing `Requires=docker.service` from automationplatform and replacing it with an internal polling loop, the service **never fails** due to Docker being in `activating` state — it simply waits until Docker responds.

---

## 4. File Inventory

### IMPORTANT: Adjust `DOCKER_DATA_ROOT` for production

The dev environment uses `/home/bali/docker-data` as Docker's data root. In production, check the actual path:

```bash
docker info 2>/dev/null | grep "Docker Root Dir"
# or
cat /etc/docker/daemon.json | grep data-root
```

Replace every occurrence of `/home/bali/docker-data` in the files below with the actual production path.

---

### File A: `/etc/docker/daemon.json`

**Purpose:** Docker daemon global configuration. Key setting: `live-restore: false` prevents Docker from trying to re-attach to previous containers on startup (which caused the stale sandbox errors).

```json
{
  "data-root": "/home/bali/docker-data",
  "live-restore": false,
  "default-shm-size": "64M",
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "storage-driver": "overlay2"
}
```

**⚠️ IMPORTANT:** If production has `"live-restore": true`, change it to `false`. This is safe — with `false`, Docker cleanly stops containers on shutdown and Docker Compose restarts them on boot. With `true`, Docker tries to reconnect to running containers which causes the stale network errors on HDD systems.

---

### File B: `/etc/systemd/system/docker.service.d/pre-clean.conf`

**Purpose:** Runs BEFORE Docker starts. Mounts RAM disks for BoltDB files (eliminates fdatasync delay) and wipes stale container/volume state.

```ini
[Service]
ExecStartPre=/bin/bash -c '\
  mkdir -p /home/bali/docker-data/network/files \
           /home/bali/docker-data/buildkit; \
  mountpoint -q /home/bali/docker-data/network/files || \
    mount -t tmpfs -o size=256M tmpfs /home/bali/docker-data/network/files; \
  mountpoint -q /home/bali/docker-data/buildkit || \
    mount -t tmpfs -o size=512M tmpfs /home/bali/docker-data/buildkit; \
  echo "RAM disks ready for Docker BoltDB"'

ExecStartPre=/bin/bash -c '\
  rm -rf /home/bali/docker-data/containers/*; \
  rm -f /home/bali/docker-data/volumes/metadata.db; \
  echo "Container state and volume index wiped (data preserved)"'
```

**⚠️ WHAT IS SAFE TO DELETE:**
- `containers/*` — container runtime configs only, NOT data. Rebuilt by docker compose.
- `volumes/metadata.db` — BoltDB index of volume names. NOT actual volume data. Data lives in `volumes/<hash>/_data/`. Deleting metadata.db causes harmless "volume already exists" warnings from docker compose but eliminates 3+ min Docker startup delay.
- `network/files/` contents — network state, rebuilt from scratch. Network data is NOT persistent.
- `buildkit/` contents — build cache metadata. Image layers in `overlay2/` are NOT touched.

**⚠️ WHAT IS NOT DELETED (actual data preserved):**
- `volumes/<hash>/_data/` — postgres data, vault data, minio data, etc.
- `overlay2/` — Docker image layers
- `image/` — Docker image manifests

---

### File C: `/etc/systemd/system/docker.service.d/startup-guard.conf`

**Purpose:** Ensures Docker restarts if it fails, and doesn't wait indefinitely on first start attempt.

```ini
[Service]
TimeoutStartSec=180
Restart=on-failure
RestartSec=15s
```

**Note:** `StartLimitIntervalSec` and `StartLimitBurst` must go in `[Unit]` section on RHEL/CentOS 7 systemd. Do NOT put them in `[Service]` — they will be silently ignored with a warning.

---

### File D: `/etc/systemd/system/automationplatform.service`

**Purpose:** Systemd service that auto-starts the Docker Compose stack on boot. Uses internal Docker polling instead of `Requires=` dependency.

```ini
[Unit]
Description=Automation Platform Docker Compose Stack (Phased Startup)
Documentation=file:///home/bali/09_automationplatform/README.md
After=docker.service containerd.service network-online.target
Wants=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/bali/09_automationplatform

ExecStartPre=/bin/bash -c '\
  echo "Waiting for Docker to be ready..."; \
  for i in $(seq 1 300); do \
    docker info >/dev/null 2>&1 && \
    echo "Docker ready after $((i*4))s" && break || \
    sleep 4; \
  done; \
  docker info >/dev/null 2>&1 || { echo "Docker not ready after 20 minutes"; exit 1; }'

ExecStart=/bin/bash /home/bali/09_automationplatform/infra/scripts/phased-startup.sh

ExecStop=/usr/bin/docker compose down --timeout 30

Restart=on-failure
RestartSec=120s

TimeoutStartSec=1800
TimeoutStopSec=60

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**⚠️ KEY DESIGN DECISION — No `Requires=docker.service`:**
Using `Requires=` causes systemd to fail automationplatform if Docker is still `activating`. On a spinning HDD, Docker can take 3-10 minutes to become `active`. The polling loop (300 × 4s = 20 min max wait) handles this gracefully.

**⚠️ SELinux Note:** `ExecStart` uses `/bin/bash /path/to/script` NOT `/path/to/script` directly. This is required because SELinux on RHEL/CentOS 7 will block direct execution of scripts in `/home` directories with `status=203/EXEC`. Calling via `/bin/bash` works because `/bin/bash` has the correct SELinux context.

---

### File E: `infra/scripts/phased-startup.sh`

**Purpose:** Starts all 33 containers in 6 dependency-ordered phases instead of all at once. Prevents health check failures and disk I/O spikes.

**Location in repo:** `infra/scripts/phased-startup.sh` (committed to git, deployed with the app)

**Make executable after deploy:**
```bash
chmod +x /path/to/infra/scripts/phased-startup.sh
```

**The 6 phases:**
```
Phase 1: vault, opensearch, dify-db, dify-redis, n8n-db, dify-sandbox
         → Gate: wait for vault port :8200 to be open

Phase 2: vault-bootstrap + all 13 vault-agents + cert-rotation-controller
         → Gate: wait for vault PKI bootstrap complete + 15s TLS cert issuance

Phase 3: postgres, redis, rabbitmq, minio, keycloak, n8n, dify-migrate
         → Gate: wait for postgres to become healthy (WAL recovery ~90-120s on HDD)

Phase 4: db-migrate (Prisma) → then dify-api + dify-worker
         → Gate: db-migrate exits 0 + dify-migrate exits 0 (takes 5-12 min on HDD)

Phase 5: workflow-service, logging-service, dify-web
         → Gate: 10s sleep for port binding

Phase 6: api-gateway → web → web-ingress (nginx)
         → Done ✅
```

**Observed timing on spinning HDD:**
- Docker ready after fdatasync: ~4-10 seconds (with tmpfs fix)
- Phase 1: ~15 seconds
- Phase 2: ~30-60 seconds
- Vault PKI bootstrap: ~2 minutes
- Phase 3 (postgres WAL recovery): ~2-3 minutes
- Phase 4 db-migrate: ~60-90 seconds
- Phase 4 dify-migrate (Flask): ~5-12 minutes (slowest step — Flask migrations on HDD)
- Phases 5+6: ~90 seconds
- **Total from boot to fully running: ~15-20 minutes**

---

## 5. Step-by-Step Implementation

### Prerequisites
- Root access on the production server
- The `09_automationplatform` repository deployed to a known path (e.g. `/opt/automationplatform` or `/home/bali/09_automationplatform`)
- Docker already installed (version 20+ required)
- `systemctl` available (RHEL/CentOS/Fedora)

### Step 1: Set Variables

```bash
# Adjust these to match your production environment
DOCKER_DATA_ROOT=$(docker info 2>/dev/null | grep "Docker Root Dir" | awk '{print $NF}')
APP_DIR="/home/bali/09_automationplatform"   # Change to production app path

echo "Docker data root: $DOCKER_DATA_ROOT"
echo "App directory: $APP_DIR"
```

### Step 2: Update `/etc/docker/daemon.json`

```bash
# Backup existing config
cp /etc/docker/daemon.json /etc/docker/daemon.json.bak.$(date +%Y%m%d)

# Ensure live-restore is false
# Edit the file and set "live-restore": false
# Then verify:
python3 -c "import json; d=json.load(open('/etc/docker/daemon.json')); print('live-restore:', d.get('live-restore', 'NOT SET'))"
```

### Step 3: Create Docker pre-start hook directory and files

```bash
mkdir -p /etc/systemd/system/docker.service.d

# Create pre-clean.conf (replace DOCKER_DATA_ROOT with actual path)
cat > /etc/systemd/system/docker.service.d/pre-clean.conf << 'EOF'
[Service]
ExecStartPre=/bin/bash -c '\
  mkdir -p DOCKER_DATA_ROOT/network/files \
           DOCKER_DATA_ROOT/buildkit; \
  mountpoint -q DOCKER_DATA_ROOT/network/files || \
    mount -t tmpfs -o size=256M tmpfs DOCKER_DATA_ROOT/network/files; \
  mountpoint -q DOCKER_DATA_ROOT/buildkit || \
    mount -t tmpfs -o size=512M tmpfs DOCKER_DATA_ROOT/buildkit; \
  echo "RAM disks ready for Docker BoltDB"'
ExecStartPre=/bin/bash -c '\
  rm -rf DOCKER_DATA_ROOT/containers/*; \
  rm -f DOCKER_DATA_ROOT/volumes/metadata.db; \
  echo "Container state and volume index wiped (data preserved)"'
EOF

# Replace placeholder with actual path
sed -i "s|DOCKER_DATA_ROOT|${DOCKER_DATA_ROOT}|g" /etc/systemd/system/docker.service.d/pre-clean.conf

# Create startup-guard.conf
cat > /etc/systemd/system/docker.service.d/startup-guard.conf << 'EOF'
[Service]
TimeoutStartSec=180
Restart=on-failure
RestartSec=15s
EOF
```

### Step 4: Create the automationplatform systemd service

```bash
# Replace APP_DIR with actual path before running
cat > /etc/systemd/system/automationplatform.service << EOF
[Unit]
Description=Automation Platform Docker Compose Stack (Phased Startup)
After=docker.service containerd.service network-online.target
Wants=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${APP_DIR}

ExecStartPre=/bin/bash -c 'echo "Waiting for Docker to be ready..."; for i in \$(seq 1 300); do docker info >/dev/null 2>&1 && echo "Docker ready after \$((i*4))s" && break || sleep 4; done; docker info >/dev/null 2>&1 || { echo "Docker not ready after 20 minutes"; exit 1; }'

ExecStart=/bin/bash ${APP_DIR}/infra/scripts/phased-startup.sh

ExecStop=/usr/bin/docker compose down --timeout 30

Restart=on-failure
RestartSec=120s
TimeoutStartSec=1800
TimeoutStopSec=60

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

### Step 5: Make the phased startup script executable

```bash
chmod +x ${APP_DIR}/infra/scripts/phased-startup.sh

# Verify it's syntactically valid
bash -n ${APP_DIR}/infra/scripts/phased-startup.sh && echo "Script syntax OK"
```

### Step 6: Reload systemd and enable the service

```bash
systemctl daemon-reload

# Enable automationplatform to start on every boot
systemctl enable automationplatform

# Verify it's enabled
systemctl is-enabled automationplatform   # should print: enabled
systemctl is-enabled docker               # should print: enabled
```

### Step 7: Test the configuration (without rebooting)

```bash
# Verify Docker pre-start hooks are registered
systemctl show docker --property=ExecStartPre | head -5

# Expected output should show the tmpfs mount and rm commands
```

### Step 8: Reboot and verify

```bash
reboot
```

After reboot, wait ~5 minutes then check:

```bash
# Check Docker is active
systemctl status docker

# Check all containers are running
docker ps

# Check automationplatform service
systemctl status automationplatform

# Follow startup progress
journalctl -u automationplatform -f
```

---

## 6. Verification

### Expected `docker ps` output after full startup (should show ~33 containers):

```
NAMES                                                  STATUS
09_automationplatform-api-gateway-1                    Up X minutes
09_automationplatform-web-1                            Up X minutes
09_automationplatform-web-ingress-1                    Up X minutes
09_automationplatform-postgres-1                       Up X minutes (healthy)
09_automationplatform-vault-1                          Up X minutes
... (29 more containers)
```

### Expected `systemctl status automationplatform` output:

```
● automationplatform.service - Automation Platform Docker Compose Stack (Phased Startup)
   Active: active (exited)    ← "exited" is CORRECT for Type=oneshot with RemainAfterExit
```

### Expected `systemctl status docker` output:

```
● docker.service - Docker Application Container Engine
  Drop-In: /etc/systemd/system/docker.service.d
           └─pre-clean.conf, startup-guard.conf
   Active: active (running)
```

### Verify tmpfs mounts are active:

```bash
mountpoint /path/to/docker-data/network/files  # should say "is a mountpoint"
mountpoint /path/to/docker-data/buildkit        # should say "is a mountpoint"
```

---

## 7. Monitoring After Reboot

### Follow the phased startup in real-time:

```bash
journalctl -u automationplatform -f
```

### Expected log progression:

```
Waiting for Docker to be ready...
Docker ready after 4s            ← with fix, Docker responds quickly
PHASE 1: Core Infrastructure...
✅ Phase 1 containers started
✅ Vault port is open
PHASE 2: Vault Bootstrap + All Vault Agents...
✅ Phase 2 containers started
✅ Vault PKI bootstrap complete
Waiting 15s for vault-agents to issue TLS certs...
PHASE 3: Data Stores + n8n + Dify Migration
✅ Phase 3 containers started
✅ Postgres is healthy
PHASE 4: Database Migrations + Dify API/Worker
✅ db-migrate completed successfully
✅ dify-migrate completed successfully    ← this takes 5-12 min on HDD
✅ Phase 4 complete
PHASE 5: Backend Services + Dify Web
✅ Phase 5 containers started
PHASE 6: API Gateway + Web Frontend + Nginx Ingress
✅ Phase 6 complete — platform is fully up
✅ ALL PHASES COMPLETE — Automation Platform is running
```

### Check Docker startup time:

```bash
journalctl -u docker | grep -E "(Starting Docker|Daemon has|RAM disk|Container state)"
```

---

## 8. Troubleshooting

### Problem: `docker ps` still hangs after fix

**Check:** Did the pre-clean hooks run?
```bash
journalctl -u docker | grep -E "(RAM disk|Container state)"
```
If not shown, the hook didn't run. Verify `systemctl show docker --property=ExecStartPre`.

**Check:** Are tmpfs mounts active?
```bash
mountpoint /path/to/docker-data/network/files
mountpoint /path/to/docker-data/buildkit
```

**Check:** Was `volumes/metadata.db` deleted?
```bash
# After reboot, before Docker starts, it should not exist
ls -la /path/to/docker-data/volumes/metadata.db
```

### Problem: `automationplatform` shows `inactive (dead)` after boot

**Check journal:**
```bash
journalctl -u automationplatform --since "boot"
```

**If "Waiting for Docker to be ready..." never appears:**
The service never started. Check if it's enabled: `systemctl is-enabled automationplatform`

**If "Docker not ready after 20 minutes" appears:**
Docker truly failed to start. Check: `journalctl -u docker --since "boot"`

### Problem: Volume warnings from docker compose

```
volume "xxx" already exists but was not created by Docker Compose
```

**This is harmless.** It appears because we delete `volumes/metadata.db` (which stores Compose ownership records). The actual volume DATA is safe. Docker Compose re-registers the volumes on first `docker compose up`.

### Problem: dify-migrate takes very long (>15 minutes)

This is an HDD limitation. Flask DB migrations on a spinning disk take 5-12 minutes. Options:
1. Move Docker data root to SSD
2. After first boot, configure dify-migrate to skip on subsequent boots (advanced)

### Problem: Phase 4 dify-migrate timeout

If you see `❌ Timeout waiting for ... after 720s`, increase the timeout in `phased-startup.sh`:
```bash
# Find this line in phased-startup.sh:
wait_for_container_exit 09_automationplatform-dify-migrate-1 720

# Change 720 to 900 (15 minutes) if needed
```

---

## 9. Important Notes for AI / Future Engineers

> **READ THIS SECTION CAREFULLY before making any changes.**

### 9.1 The Core Problem Pattern

When `docker ps` hangs and returns no output after server reboot, the cause is **always** BoltDB fdatasync blocking Docker's goroutine on a spinning HDD. Do NOT assume Docker is broken. Do NOT reinstall Docker. The goroutine dump (`kill -SIGUSR1 $(pgrep dockerd)`) will show goroutine 1 stuck in `bbolt.fdatasync`.

### 9.2 What `live-restore: false` Does

With `live-restore: false`, Docker does NOT keep containers running during daemon restart. Instead:
- On shutdown: Docker stops all containers gracefully
- On start: Docker loads clean state, no container reconnection
- `docker compose up` (via automationplatform service) brings everything back

This is the correct behavior for this platform. Do NOT change it to `true` — that was the original cause of the stale sandbox errors.

### 9.3 What Is Safe to Delete Before Docker Starts

| Path | Safe to delete? | Why |
|------|----------------|-----|
| `containers/*` | ✅ YES | Runtime configs, rebuilt by compose |
| `network/files/local-kv.db` | ✅ YES | Network state, always rebuilt |
| `volumes/metadata.db` | ✅ YES | Volume index only, NOT volume data |
| `buildkit/` | ✅ YES | Build cache, rebuilt on demand |
| `volumes/<hash>/_data/` | ❌ NO | Actual postgres/vault/minio DATA |
| `overlay2/` | ❌ NO | Docker image layers |
| `image/` | ❌ NO | Docker image manifests |

### 9.4 Why `Requires=docker.service` Cannot Be Used

Systemd's `Requires=` checks that the dependency is in `active` state. Docker on a spinning HDD stays in `activating` state for 3-10 minutes due to BoltDB fdatasync. Using `Requires=` causes an immediate `dependency failed` error.

The fix uses `Wants=` + `After=` (ordering without hard dependency) plus an internal polling loop that waits up to 20 minutes for `docker info` to succeed. This is robust to any Docker startup delay.

### 9.5 The tmpfs RAM Disk Trick

Mounting tmpfs over Docker's BoltDB directories means:
1. All BoltDB writes go to RAM (microsecond fsync instead of HDD millisecond fsync)
2. Docker's goroutine 1 is never blocked
3. Docker becomes API-responsive in ~4-10 seconds

These tmpfs mounts are mounted in the Docker ExecStartPre hook, so they're set up fresh on every Docker start. They survive Docker restarts but NOT server reboots (tmpfs is RAM, it's wiped on reboot). This is correct — the ExecStartPre hook re-mounts them on every Docker start.

### 9.6 The Volume Warnings Are Expected and Harmless

After deleting `volumes/metadata.db`, docker compose will log:
```
volume "xxx" already exists but was not created by Docker Compose. Use `external: true`
```
This is because Docker Compose lost its ownership records for those volumes. The volumes and all their data are intact. Docker Compose re-registers them automatically when it runs. These warnings can be safely ignored.

### 9.7 SELinux Compatibility

On RHEL/CentOS 7 with SELinux enforcing:
- Scripts in `/home` cannot be directly executed by systemd (status=203/EXEC)
- Solution: Use `ExecStart=/bin/bash /home/...` instead of `ExecStart=/home/...`
- `/bin/bash` has the correct SELinux type `bin_t` which systemd can execute

### 9.8 Boot Timeline Reference

```
T+0:00  Server boots
T+0:30  Docker service starts, pre-clean hooks run (tmpfs + wipe)
T+0:35  dockerd process starts
T+1:00  "Daemon has completed initialization" (still activating for systemd)
T+3:00  Docker socket becomes responsive (BoltDB fdatasync completes)
T+3:04  automationplatform polls docker info → "Docker ready after 4s"
T+3:15  Phase 1 complete (vault, opensearch, DBs)
T+3:45  Phase 2 complete (all vault-agents)
T+5:45  Vault PKI bootstrap complete
T+6:00  Phase 3 complete (postgres, redis, etc.)
T+8:00  Postgres healthy (WAL recovery on HDD)
T+9:30  db-migrate complete
T+14:30 dify-migrate complete (5-12 min Flask migrations on HDD)
T+16:00 Phase 4 complete (dify-api/worker)
T+17:30 Phases 5+6 complete (services + frontend)
T+18:00 ALL PHASES COMPLETE — Platform fully running
```

---

*Document created: 2026-04-30 | Platform: 09_automationplatform | Server: RHEL 4.18, Spinning HDD (TOSHIBA MK1059GSMP)*
