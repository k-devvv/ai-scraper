# ai-scraper

> Local-first AI extraction pipeline. Stealth crawl → clean Markdown → typed JSON via Ollama. Zero API cost.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Ollama](https://img.shields.io/badge/Ollama-local%20inference-black)](https://ollama.com/)
[![Playwright](https://img.shields.io/badge/Playwright-stealth-green)](https://playwright.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

Most scrapers stop at raw HTML or charge per-call for AI extraction. This one runs the full pipeline locally — stealth fetch → token-optimised Markdown → schema-enforced JSON via a local LLM. No cloud API required.

**Where it fits vs the alternatives:**

| | ai-scraper | Firecrawl | Scrapling |
|---|---|---|---|
| AI extraction layer | ✅ local Ollama | ✅ cloud (paid) | ❌ |
| Stealth browser | ✅ 11 evasion scripts | ✅ managed | ✅ best-in-class |
| Token optimisation | ✅ Turndown −60–80% | ✅ | partial |
| Schema-typed output | ✅ 8 schemas + custom | partial | ❌ |
| Zero inference cost | ✅ | ❌ | ✅ |
| Self-hostable | ✅ | ❌ | ✅ |

---

## How it works

```
URL / Sitemap / Seed
        │
        ▼
┌─────────────────────────────────────────┐
│  sitemap.ts   sitemap.xml + robots.txt  │
│  crawler.ts   BFS deep crawl, queued    │
└────────────────────┬────────────────────┘
                     │ URLs
                     ▼
┌─────────────────────────────────────────┐
│  browser.ts   Stealth Playwright        │
│               11 evasion scripts        │
│               Random UA/viewport/locale │
│  fetcher.ts   Fast HTTP fallback        │
└────────────────────┬────────────────────┘
                     │ raw HTML
                     ▼
┌─────────────────────────────────────────┐
│  cleaner.ts   Turndown HTML → Markdown  │
│               −60–80% token reduction   │
└────────────────────┬────────────────────┘
                     │ clean Markdown
                     ▼
┌─────────────────────────────────────────┐
│  pipeline.ts  Hybrid extraction         │
│               1. Cheerio (fast path)    │
│               2. Ollama AI (fallback)   │
│               Confidence scoring        │
│               → routes to best result   │
│  extractor.ts Ollama JSON enforcement   │
│  schemas.ts   8 built-in schemas        │
└────────────────────┬────────────────────┘
                     │ typed JSON
                     ▼
┌─────────────────────────────────────────┐
│  output.ts    JSON / CSV / MD / JSONL   │
└─────────────────────────────────────────┘
```

The pipeline uses a **confidence-scoring hybrid**: Cheerio runs first for speed; if the structured output scores below threshold, Ollama takes over. This avoids burning local inference on pages that parse cleanly with selectors.

---

## Setup

**Requirements:** Node.js 18+, [Ollama](https://ollama.com/) running locally with `qwen2.5:7b` pulled.

```bash
npm install
npx playwright install chromium
ollama pull qwen2.5:7b
```

---

## Commands

### Single URL
```bash
npx tsx src/cli.ts scrape <url> <schema> [flags]

npx tsx src/cli.ts scrape https://n8n.io/pricing pricing --output=json,csv
npx tsx src/cli.ts scrape https://blog.n8n.io/ai-agents-examples/ saas_ideas
```

### Deep Crawl — follows links recursively
```bash
npx tsx src/cli.ts crawl <url> <schema> [flags]

# AI agent ideas from n8n blog (20 pages, depth 2)
npx tsx src/cli.ts crawl https://blog.n8n.io saas_ideas --pages=20 --depth=2 --output=json,csv

# Product Hunt AI agents category
npx tsx src/cli.ts crawl https://www.producthunt.com/topics/ai-agents saas_ideas --pages=30

# There's An AI For That directory
npx tsx src/cli.ts crawl https://theresanaiforthat.com saas_ideas --pages=50 --delay=1000
```

### Sitemap — fastest for large sites
```bash
npx tsx src/cli.ts sitemap <url> <schema> [flags]

npx tsx src/cli.ts sitemap https://n8n.io saas_ideas --include=/blog/ --pages=30 --output=json,csv
npx tsx src/cli.ts sitemap https://www.ycombinator.com blog --include=/blog/ --pages=20
```

### Batch — multiple URLs in one shot
```bash
npx tsx src/cli.ts batch <url1,url2,...> <schema> [flags]

# Compare SaaS pricing pages
npx tsx src/cli.ts batch https://n8n.io/pricing,https://make.com/en/pricing,https://zapier.com/pricing pricing --output=json,csv,markdown
```

### Markdown only — no AI, fastest
```bash
npx tsx src/cli.ts markdown <url>
npx tsx src/cli.ts markdown https://blog.n8n.io/ai-agents-examples/
```

---

## Schemas

| Schema | Best for |
|---|---|
| `product` | E-commerce pages |
| `article` | News / editorial |
| `job` | Job listings |
| `saas_ideas` | AI/SaaS idea blogs and directories |
| `blog` | Blog posts (tools, companies, code) |
| `company` | Company / startup profiles |
| `pricing` | SaaS pricing pages |
| `review` | Review and testimonial pages |

### Add a custom schema

Edit `schemas.ts`, add your interface and schema object, register it in `SCHEMA_MAP`:

```typescript
export const mySchema: OllamaSchema = {
  name: "extract_my_data",
  description: "Extract X from Y pages.",
  input_schema: {
    type: "object",
    properties: {
      field_one: { type: "string" },
      field_two: { type: "array", items: { type: "string" } },
    },
    required: ["field_one"],
  },
};

export const SCHEMA_MAP = {
  // ...existing
  my_schema: mySchema,
} as const;
```

Then:
```bash
npx tsx src/cli.ts crawl https://example.com my_schema --pages=20
```

---

## Flags

| Flag | Default | Description |
|---|---|---|
| `--output=json,csv,md` | `json` | Output formats |
| `--out-dir=./output` | `./output` | Save directory |
| `--depth=3` | `3` | Max crawl depth |
| `--pages=50` | `50` | Max pages |
| `--concurrency=2` | `2` | Parallel requests |
| `--delay=500` | `500` | ms between requests |
| `--include=/blog/` | — | URL path filter |
| `--model=qwen2.5:7b` | `qwen2.5:7b` | Ollama model |
| `--no-extract` | — | Skip AI, save Markdown only |

---

## Sample output

Scraping `https://n8n.io/pricing` with the `pricing` schema:

```json
{
  "url": "https://n8n.io/pricing",
  "schema": "pricing",
  "extracted_at": "2026-06-11T07:14:00Z",
  "data": {
    "plans": [
      { "name": "Starter", "price": "$20/mo", "highlights": ["5 active workflows", "10k executions"] },
      { "name": "Pro", "price": "$50/mo", "highlights": ["15 active workflows", "50k executions"] },
      { "name": "Enterprise", "price": "Custom", "highlights": ["Unlimited workflows", "SSO", "SLA"] }
    ]
  },
  "confidence": 0.91,
  "extraction_method": "ollama"
}
```

---

## Good crawl targets for SaaS / AI agent research

```bash
# n8n blog — enterprise automation deep dives
npx tsx src/cli.ts crawl https://blog.n8n.io saas_ideas --pages=30 --depth=2 --output=json,csv

# There's An AI For That — AI product directory
npx tsx src/cli.ts crawl https://theresanaiforthat.com saas_ideas --pages=50 --delay=1000

# Product Hunt AI Agents
npx tsx src/cli.ts crawl "https://www.producthunt.com/topics/ai-agents" saas_ideas --pages=20

# YC blog — startup ideas and trends
npx tsx src/cli.ts sitemap https://www.ycombinator.com blog --include=/blog/ --pages=25 --output=json,csv

# Make.com use cases
npx tsx src/cli.ts sitemap https://www.make.com saas_ideas --include=/use-cases/ --pages=30
```

---

## Roadmap

- [ ] REST API wrapper — expose pipeline as a local HTTP service
- [ ] MCP adapter — plug directly into AI agent workflows
- [ ] Scrapling fetcher backend — inherit Cloudflare Turnstile bypass
- [ ] Streaming output — `async for item` interface for long crawls

---

## License

MIT
