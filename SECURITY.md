# Security Policy

## Reporting vulnerabilities

If you discover a security vulnerability, please email **security@[your-domain]** with a description and steps to reproduce. Do **not** open a public issue. We will respond within 48 hours.

---

## Architecture security overview

```
Internet → [Firewall/Reverse Proxy] → [API Container :3000] → [Ollama Container :11434]
                                              ↓
                                       [SQLite / Redis]
```

The API container is the only service exposed to the network. Ollama and Redis run on an internal Docker network with no external port bindings in production.

---

## Firewall rules (UFW / iptables)

### Recommended UFW setup for a production VPS

```bash
# Reset to deny-all defaults
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH (change port if you use a non-standard SSH port)
sudo ufw allow 22/tcp comment "SSH"

# API endpoint — only expose through reverse proxy (Nginx/Caddy)
# If using a reverse proxy on the same machine:
sudo ufw allow from 127.0.0.1 to any port 3000 proto tcp comment "API (local only)"
# If exposing directly (NOT recommended for production):
# sudo ufw allow 3000/tcp comment "API (direct)"

# HTTPS via reverse proxy
sudo ufw allow 443/tcp comment "HTTPS"
sudo ufw allow 80/tcp comment "HTTP (redirect to HTTPS)"

# Block Ollama from external access (critical — LLM inference should never be public)
sudo ufw deny 11434/tcp comment "Block Ollama external access"

# Block Redis from external access
sudo ufw deny 6379/tcp comment "Block Redis external access"

# Enable firewall
sudo ufw enable
sudo ufw status verbose
```

### iptables equivalent

```bash
# Drop all incoming by default
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT ACCEPT

# Allow loopback
iptables -A INPUT -i lo -j ACCEPT

# Allow established connections
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# SSH
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# HTTPS + HTTP
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
iptables -A INPUT -p tcp --dport 80 -j ACCEPT

# API — only from localhost (reverse proxy)
iptables -A INPUT -p tcp --dport 3000 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP

# Block Ollama and Redis from external
iptables -A INPUT -p tcp --dport 11434 -j DROP
iptables -A INPUT -p tcp --dport 6379 -j DROP
```

---

## Docker network security

### Production docker-compose.yml hardening

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    # NO ports mapping — internal network only
    # ports:           ← REMOVED in production
    #   - "11434:11434"
    networks:
      - internal

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}
    # NO ports mapping — internal network only
    networks:
      - internal

  api:
    build: .
    ports:
      - "127.0.0.1:3000:3000"   # Bind to localhost only (reverse proxy in front)
    networks:
      - internal
      - external
    environment:
      OLLAMA_HOST: http://ollama:11434
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379

networks:
  internal:
    driver: bridge
    internal: true    # No external internet access for Ollama/Redis
  external:
    driver: bridge    # API can reach the internet (for scraping)
```

Key changes from development:
- Ollama and Redis have **no port bindings** (zero external exposure)
- API binds to `127.0.0.1:3000` only (requires a reverse proxy like Nginx/Caddy)
- Internal network is marked `internal: true` — containers on it cannot reach the internet
- Redis requires a password via `--requirepass`

---

## Reverse proxy (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    # Security headers (supplement Helmet)
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    # Rate limiting at Nginx level (defense in depth)
    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/m;

    location / {
        limit_req zone=api burst=10 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts for long-running scrape jobs
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;

        # Limit upload size
        client_max_body_size 1m;
    }

    # Block direct access to Swagger in production (optional)
    # location /docs {
    #     deny all;
    # }
}

server {
    listen 80;
    server_name api.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

---

## Application-level security

### Already implemented

| Protection | Implementation | Status |
|---|---|---|
| API key authentication | `X-API-Key` header check | ✅ |
| Rate limiting | `@fastify/rate-limit` — 60 req/min per key/IP | ✅ |
| Security headers | `@fastify/helmet` — CSP, HSTS, X-Frame-Options | ✅ |
| CORS | `@fastify/cors` — configurable allowed origins | ✅ |
| SSRF prevention | URL validation blocks localhost, private IPs, metadata endpoints | ✅ |
| Input validation | Fastify JSON schema validation on all request bodies | ✅ |
| Body size limit | 1MB max request body | ✅ |
| Request ID tracking | `X-Request-Id` header on all responses | ✅ |
| Graceful shutdown | SIGTERM/SIGINT handlers close Redis + SQLite cleanly | ✅ |
| URL sanitization | Block `file://`, `ftp://`, `data:`, `javascript:` protocols | ✅ |
| Proxy validation | Validate proxy URLs before passing to fetcher | ✅ |

### Recommended additions for production

| Protection | How to implement |
|---|---|
| TLS everywhere | Nginx/Caddy with Let's Encrypt in front of the API |
| API key rotation | Store keys in Redis with expiry; add `/v1/keys/rotate` admin endpoint |
| Request logging | Ship pino logs to ELK/Loki for audit trail |
| Dependency scanning | Add `npm audit` and Snyk to CI pipeline |
| Container scanning | Add Trivy scan in GitHub Actions |
| Secrets management | Use Docker secrets or Vault instead of `.env` files |
| Fail2ban | Block IPs that hit 401/429 repeatedly |
| Domain allowlist | Optional `ALLOWED_DOMAINS` env var to restrict which domains can be scraped |

---

## Environment variables security

```bash
# NEVER commit .env to git (it's in .gitignore)
# NEVER hardcode API keys in source code
# ALWAYS use strong, random API keys:
#   openssl rand -hex 32

API_KEY=your-64-char-hex-key-here
REDIS_PASSWORD=another-strong-random-password
```

---

## Dependency security

Run these regularly:

```bash
# Check for known vulnerabilities
npm audit

# Fix automatically where possible
npm audit fix

# Check for outdated packages
npm outdated

# In CI (GitHub Actions), add:
# - name: Security audit
#   run: npm audit --audit-level=high
```

---

## Supported versions

| Version | Supported |
|---|---|
| 3.1.x | ✅ Active |
| 3.0.x | ⚠️ Security fixes only |
| < 3.0 | ❌ Unsupported |
