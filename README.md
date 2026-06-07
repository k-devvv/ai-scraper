# AI Web Scraper v2.0

Production-grade scraper with deep crawling, sitemap discovery, and local AI extraction via Ollama — comparable to Firecrawl and xCrawl, zero API cost.

## Architecture

```
URL / Sitemap / Seed
        │
        ▼
┌─────────────────────┐
│  sitemap.ts         │  Discovers URLs from sitemap.xml, robots.txt
│  crawler.ts         │  BFS deep crawl, link following, concurrency
└────────┬────────────┘
         │ URLs
         ▼
┌─────────────────────┐
│  browser.ts         │  Stealth Playwright (11 evasion scripts)
│  Fingerprint rotate │  Random UA, viewport, locale per request
└────────┬────────────┘
         │ raw HTML
         ▼
┌─────────────────────┐
│  cleaner.ts         │  Turndown HTML → Markdown (-60-80% tokens)
└────────┬────────────┘
         │ clean Markdown
         ▼
┌─────────────────────┐
│  extractor.ts       │  Ollama local AI, JSON schema enforcement
│  schemas.ts         │  8 built-in schemas, add your own
└────────┬────────────┘
         │ typed JSON
         ▼
┌─────────────────────┐
│  output.ts          │  JSON, CSV, Markdown, JSONL export
└─────────────────────┘
```

## Setup

```bash
npm install
npx playwright install chromium
```

## Commands

### Single URL
```bash
npx tsx src/cli.ts scrape <url> <schema> [model]

# Examples
npx tsx src/cli.ts scrape https://n8n.io/pricing pricing --output=json,csv
npx tsx src/cli.ts scrape https://blog.n8n.io/ai-agents-examples/ saas_ideas
```

### Deep Crawl (follows links recursively)
```bash
npx tsx src/cli.ts crawl <url> <schema> [flags]

# Scrape all AI agent ideas from n8n blog (up to 20 pages, depth 2)
npx tsx src/cli.ts crawl https://blog.n8n.io saas_ideas --pages=20 --depth=2 --output=json,csv

# Crawl Product Hunt AI agents category
npx tsx src/cli.ts crawl https://www.producthunt.com/topics/ai-agents saas_ideas --pages=30

# Crawl There's An AI For That
npx tsx src/cli.ts crawl https://theresanaiforthat.com saas_ideas --pages=50 --delay=1000
```

### Sitemap Scraping (fastest for large sites)
```bash
npx tsx src/cli.ts sitemap <url> <schema> [flags]

# Scrape all blog posts from n8n via sitemap
npx tsx src/cli.ts sitemap https://n8n.io saas_ideas --include=/blog/ --pages=30 --output=json,csv

# Scrape YC blog
npx tsx src/cli.ts sitemap https://www.ycombinator.com blog --include=/blog/ --pages=20
```

### Batch (multiple URLs at once)
```bash
npx tsx src/cli.ts batch <url1,url2,...> <schema> [flags]

# Compare pricing of multiple SaaS tools
npx tsx src/cli.ts batch https://n8n.io/pricing,https://make.com/en/pricing,https://zapier.com/pricing pricing --output=json,csv,markdown
```

### Markdown Only (no AI, fastest)
```bash
npx tsx src/cli.ts markdown <url>

npx tsx src/cli.ts markdown https://blog.n8n.io/ai-agents-examples/
```

## Schemas

| Schema | Best For |
|--------|----------|
| `product` | E-commerce pages |
| `article` | News articles |
| `job` | Job listings |
| `saas_ideas` | AI/SaaS idea blogs, directories |
| `blog` | Blog posts (tools, companies, code) |
| `company` | Company/startup profiles |
| `pricing` | SaaS pricing pages |
| `review` | Review and testimonial pages |

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--output=json,csv,md` | `json` | Output formats |
| `--out-dir=./output` | `./output` | Save directory |
| `--depth=3` | `3` | Max crawl depth |
| `--pages=50` | `50` | Max pages |
| `--concurrency=2` | `2` | Parallel requests |
| `--delay=500` | `500` | Ms between requests |
| `--include=/blog/` | — | URL path filter |
| `--model=qwen2.5:7b` | `qwen2.5:7b` | Ollama model |
| `--no-extract` | — | Skip AI, save markdown |

## Best targets for SaaS AI agent ideas

```bash
# n8n blog — deep dives on enterprise automation
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

## Adding a Custom Schema

Edit `src/schemas.ts` — add your interface and schema object, then add it to `SCHEMA_MAP`:

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
  // ... existing schemas
  my_schema: mySchema,
} as const;
```

Then use it:
```bash
npx tsx src/cli.ts crawl https://example.com my_schema --pages=20
```
