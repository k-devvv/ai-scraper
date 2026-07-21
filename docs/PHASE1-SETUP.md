# Phase 1 — Containerized REST API Setup Guide

> **Goal:** Run `ai-scraper` as a production-ready Fastify REST API, containerised with Docker Compose alongside a local Ollama instance.

---

## Quick Start (3 commands)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env if needed (defaults work out of the box for local dev)

# 3. Run locally (no Docker needed for dev)
npx tsx api/server.ts
```

Open **http://localhost:3000/docs** to see the Swagger UI.

---

## File Layout

After Phase 1, the project root contains these new/modified files:

```
ai-scraper/
├── api/
│   ├── server.ts              ← Fastify entry point (NEW)
│   ├── jobs/
│   │   ├── store.ts           ← In-memory job store with TTL (NEW)
│   │   └── runner.ts          ← p-queue async job runner (NEW)
│   └── routes/
│       ├── health.ts          ← GET /v1/health (NEW)
│       ├── schemas.ts         ← GET /v1/schemas (NEW)
│       ├── jobs.ts            ← GET/DELETE /v1/jobs (NEW)
│       ├── scrape.ts          ← POST /v1/scrape (NEW)
│       ├── crawl.ts           ← POST /v1/crawl (NEW)
│       ├── batch.ts           ← POST /v1/batch (NEW)
│       └── sitemap.ts         ← POST /v1/sitemap (NEW)
├── src/                       ← Existing core modules (unchanged)
├── Dockerfile                 ← Multi-stage build (NEW)
├── docker-compose.yml         ← api + ollama services (NEW)
├── .dockerignore              ← (NEW)
├── .env.example               ← All configurable vars (NEW)
├── .github/workflows/ci.yml   ← Node 22 CI pipeline (NEW)
├── tsconfig.json              ← Updated: CommonJS module target
├── tsconfig.build.json        ← Separate emit-only build config (NEW)
└── package.json               ← Updated: pinned deps, build scripts
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | API listen port |
| `HOST` | `0.0.0.0` | API listen host |
| `NODE_ENV` | `development` | `production` disables pino-pretty |
| `API_KEY` | *(empty)* | Set to require `X-API-Key` header (leave empty to disable auth) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint. Use `http://ollama:11434` in Docker |
| `DEFAULT_MODEL` | `qwen2.5:7b` | Ollama model used when callers omit `model` |
| `WORKER_CONCURRENCY` | `2` | Parallel jobs in the queue |
| `DEFAULT_MAX_PAGES` | `20` | Crawl/sitemap page cap when not specified by caller |
| `DEFAULT_CONCURRENCY` | `3` | Parallel fetches per crawl/batch |
| `DEFAULT_DELAY_MS` | `200` | ms between requests per crawl |

---

## API Endpoints

All endpoints return `202 Accepted` with a `jobId`. Poll `GET /v1/jobs/:id` to check status.

### `POST /v1/scrape`
Single URL extraction.
```json
{
  "url": "https://n8n.io/pricing",
  "schema": "pricing",
  "model": "qwen2.5:7b",
  "mode": "hybrid",
  "fetchMode": "auto"
}
```

### `POST /v1/crawl`
Deep BFS crawl from a seed URL.
```json
{
  "url": "https://blog.n8n.io",
  "schema": "saas_ideas",
  "maxDepth": 2,
  "maxPages": 20,
  "delayMs": 300
}
```

### `POST /v1/batch`
Multiple URLs with the same schema.
```json
{
  "urls": ["https://n8n.io/pricing", "https://make.com/en/pricing"],
  "schema": "pricing"
}
```

### `POST /v1/sitemap`
Discover via sitemap, then scrape.
```json
{
  "url": "https://n8n.io",
  "schema": "saas_ideas",
  "pathPrefix": "/blog/",
  "maxPages": 30
}
```

### `GET /v1/jobs/:id`
Poll for result.
```json
{
  "id": "uuid",
  "status": "completed",
  "progress": 100,
  "result": { ... }
}
```

### `GET /v1/health`
```json
{ "status": "ok", "ollama": "reachable", "uptime": 42, "timestamp": "..." }
```

### `GET /v1/schemas`
```json
{ "schemas": ["product", "article", "job", "saas_ideas", "blog", "company", "pricing", "review"] }
```

---

## Docker Deployment

### Prerequisites
- Docker 24+ and Docker Compose v2+
- `ollama` image will be pulled automatically

### Start the stack

```bash
# 1. Build and start (first run pulls ~4GB Ollama image)
docker compose up -d

# 2. Wait for Ollama to be healthy, then pull the model
docker compose exec ollama ollama pull qwen2.5:7b

# 3. Check health
curl http://localhost:3000/v1/health
```

### Stop the stack

```bash
docker compose down          # Keep volumes (model stays downloaded)
docker compose down -v       # Remove all volumes (model deleted)
```

### Rebuild after code changes

```bash
docker compose build api     # Rebuild only the api image
docker compose up -d api     # Restart with new image
```

---

## Local Development

```bash
# Install Playwright browser (one-time)
npx playwright install chromium

# Start API in dev mode (pino-pretty logs, hot reload via tsx)
npx tsx api/server.ts

# Or use nodemon-like watch
npx tsx watch api/server.ts
```

### Test endpoints locally

```bash
# Health
curl http://localhost:3000/v1/health

# Scrape (cheerio mode — fast, no Ollama needed)
curl -X POST http://localhost:3000/v1/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://scrapeme.live/shop/Bulbasaur/","schema":"product","mode":"cheerio"}'

# Poll job
curl http://localhost:3000/v1/jobs/<jobId>
```

---

## CI/CD (GitHub Actions)

The `.github/workflows/ci.yml` pipeline runs on every push to `main`:

1. **TypeScript type-check** — `tsc --noEmit`
2. **Build** — `npm run build` → `dist/`
3. **Docker build validation** — builds the image without pushing

### Secrets required for Docker Hub push (optional)
Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` to repo secrets, then uncomment the push step in the workflow.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module 'fastify'` | Run `npm install` |
| `Ollama connection refused` | Start Ollama: `ollama serve` (local) or check Docker: `docker compose ps` |
| `TS2339: Property X does not exist` | Check `tsconfig.json` uses `"module": "CommonJS"` — NodeNext breaks `.ts` imports in CJS context |
| Port 3000 already in use | Set `PORT=3001` in `.env` |
| `playwright install` fails in Docker | Ensure `apt-get install` Playwright deps ran; rebuild with `docker compose build --no-cache api` |
| Rate limit 429 | Default is 60 req/min per IP/key; adjust `max` in `api/server.ts` |

---

## Architecture Notes

### Why async jobs instead of sync responses?
Scraping + AI extraction can take 5–60 seconds per URL. Returning `202 Accepted` with a job ID and poll URL avoids HTTP timeouts and lets the client handle long-running operations cleanly.

### Why CommonJS instead of ESM?
`tsx` (used for local dev) works perfectly with CommonJS. The ESM-only dependencies (`p-queue`, `p-limit`, `p-retry`) in the upstream repo have been pinned to their last CJS-compatible versions in `package.json` to avoid `require()` of ES module errors.

### Ollama host routing
- **Local dev:** `OLLAMA_HOST=http://localhost:11434`
- **Docker Compose:** `OLLAMA_HOST=http://ollama:11434` (Docker internal DNS)
- **Remote Ollama server:** `OLLAMA_HOST=http://192.168.1.x:11434`
