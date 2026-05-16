# Edge Gateway Migration Plan

## Overview
Moving the ingress infrastructure (Cloudflare Tunnel and NGINX) from the host OS into Docker containers. This ensures the host network is secure, no inbound ports are exposed to the public internet, and capacity issues are mitigated through containerized Rate Limiting and a Web Application Firewall (ModSecurity).

## Objectives
1. **Containerize Ingress:** Run `cloudflared` and `nginx` as Docker containers.
2. **Implement WAF:** Utilize `owasp/modsecurity-crs:nginx-alpine` for low-footprint threat protection.
3. **Capacity Protection:** Implement NGINX `limit_req` and `limit_conn` based on the actual customer IP (`CF-Connecting-IP`).
4. **Traffic Monitoring:** Deploy GoAccess for real-time visualization of NGINX logs, blocked IPs, and rate-limiting triggers.
5. **Portability:** Ensure the entire stack is self-contained in `/home/bali/edge-gateway` and configurable via `.env`.
6. **Minimize Disk Usage:** Use Alpine Linux-based images and Docker log rotation.

## Implementation Steps
- [ ] Create portable `/home/bali/edge-gateway` directory structure
- [ ] Create `.env` framework for system-agnostic configuration
- [ ] Write Architecture, Portability & Operations documentation (`README.md`)
- [ ] Create Edge `docker-compose.yml` using Alpine/optimized images and relative paths
- [ ] Implement Docker log rotation to save disk space
- [ ] Migrate Nginx configs ensuring internal SSL/HTTPS proxying
- [ ] Implement HTTPS-only enforcement & Cloudflare IP trust (`CF-Connecting-IP`)
- [ ] Add rate limiting (`limit_req`) and connection limiting (`limit_conn`)
- [ ] Configure WAF (ModSecurity) settings
- [ ] Set up GoAccess for traffic/WAF monitoring UI
- [x] Provide safe cutover instructions from Host to Edge Stack

## Status
- **Current Phase:** Migration Completed & Validated.

## Cutover History & Final Configuration

The cutover from the host OS services to the containerized Edge Gateway was successfully completed on May 16, 2026.

### Key Configuration Changes Post-Cutover

During the migration, the following adjustments were made to ensure the stack functions securely and reliably:

1. **Host Network Mode:** The `nginx-waf` and `cloudflared` containers run using `network_mode: "host"`. This is required to properly route Cloudflare Tunnel traffic while maintaining correct IP bindings.
2. **Docker DNS Resolution:** Because the gateway uses host networking, NGINX cannot resolve internal Docker Compose service names (e.g., `host.docker.internal` or `api-gateway`). All proxy passes now point directly to `127.0.0.1:<port>`.
3. **Firewall Requirements:** Docker host networking bypasses Docker's automated `iptables` rules. To allow local access to the Edge Gateway and GoAccess dashboard, we manually opened port `80` (HTTP) and `7890` (WebSocket) in `firewalld`:
   ```bash
   sudo firewall-cmd --permanent --add-port=80/tcp
   sudo firewall-cmd --permanent --add-port=7890/tcp
   sudo firewall-cmd --reload
   ```
4. **Traffic Monitoring (GoAccess):** The GoAccess dashboard was removed from the public `theaitools.ca` domain for privacy. It is now accessed locally via the server's IP address on port 80: `http://<your-server-ip>/admin/traffic/`.
5. **Log Configuration:** NGINX was configured to write logs to an actual file (`/var/log/nginx/goaccess.log`) instead of `/dev/stdout` to allow the GoAccess container to parse them successfully.

## Legacy Cutover Instructions

To safely cut over from the host OS services to the new containerized Edge Gateway, perform the following steps:

1. **Prepare Environment Variables & Secrets:**
   ```bash
   cd /home/bali/edge-gateway
   cp .env.example .env
   # Ensure CLOUDFLARE_TUNNEL_TOKEN is set in .env to aed43f3d-5d9f-4dc0-897d-4534e5bca53e

   # Copy the tunnel credentials from root into the edge-gateway dir so docker can mount it if needed
   # Note: Since the compose file uses the token via ENV, the credentials json file isn't strictly necessary
   # as long as the token variable is set.
   ```

2. **Start the Edge Stack:**
   ```bash
   docker compose up -d
   ```
   *Verify that the containers start correctly (`docker compose ps` and `docker compose logs`).*

3. **Stop Host NGINX:**
   Stop the host NGINX to ensure it no longer processes traffic and frees up any conflicting ports.
   ```bash
   sudo systemctl stop nginx
   sudo systemctl disable nginx
   ```

4. **Stop Host Cloudflared:**
   Stop the host cloudflared service so that traffic routes to the new containerized tunnel.
   ```bash
   sudo systemctl stop cloudflared
   sudo systemctl disable cloudflared
   ```

5. **Validation:**
   * Open your browser and navigate to `https://theaitools.ca` and `https://dev.eclassmanager.com`.
   * Open `http://<your-server-ip>/admin/traffic/` to verify GoAccess is actively parsing logs.
   * If any issues occur, you can revert by stopping the docker containers (`docker compose down`) and starting the host services (`sudo systemctl start cloudflared nginx`).
