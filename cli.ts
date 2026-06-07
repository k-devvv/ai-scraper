#!/usr/bin/env node
/**
 * cli.ts
 * Main CLI entry point — replaces the basic one in scraper.ts.
 *
 * Commands:
 *   scrape   <url> [schema] [model]          — Single URL extraction
 *   batch    <url1,url2,...> [schema] [model] — Multiple URLs
 *   crawl    <url> [schema]                  — Deep recursive crawl
 *   sitemap  <url> [schema]                  — Crawl via sitemap.xml
 *   markdown <url>                           — Raw markdown only (no AI)
 *
 * Flags (all commands):
 *   --output=json,csv,markdown,jsonl         — Output formats (comma-separated)
 *   --out-dir=./output                       — Output directory
 *   --depth=3                                — Max crawl depth
 *   --pages=50                               — Max pages
 *   --concurrency=2                          — Parallel pages
 *   --delay=500                              — Ms between requests
 *   --include=/blog/                         — URL path prefix filter
 *   --model=qwen2.5:7b                       — Ollama model
 *   --no-extract                             — Skip AI, markdown only
 *
 * Run:
 *   npx tsx src/cli.ts scrape https://example.com product
 *   npx tsx src/cli.ts crawl  https://blog.n8n.io saas_ideas --pages=20
 *   npx tsx src/cli.ts sitemap https://n8n.io saas_ideas --include=/blog/
 */

import { scrapeOne, scrapeBatch } from "./scraper";
import { crawl } from "./crawler";
import { discoverSitemapUrls } from "./sitemap";
import {
  writeSingleResult,
  writeBatchResults,
  writeCrawlResults,
  writeMarkdownDump,
  type OutputFormat,
} from "./output";
import { SCHEMA_MAP, type SchemaKey } from "./schemas";
import { fetchPage } from "./browser";
import { htmlToMarkdown } from "./cleaner";

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, val] = arg.slice(2).split("=");
      flags[key] = val ?? true;
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] ?? "help",
    positional: positional.slice(1),
    flags,
  };
}

function getFlag(flags: Record<string, string | boolean>, key: string, fallback: string): string {
  const val = flags[key];
  return typeof val === "string" ? val : fallback;
}

function getFormats(flags: Record<string, string | boolean>): OutputFormat[] {
  const raw = getFlag(flags, "output", "json");
  return raw.split(",").map((f) => f.trim() as OutputFormat);
}

function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║          AI Web Scraper — Powered by Ollama (local)         ║
╚══════════════════════════════════════════════════════════════╝

COMMANDS:
  scrape  <url> [schema] [model]     Extract data from a single URL
  batch   <urls> [schema] [model]    Extract from multiple URLs (comma-separated)
  crawl   <url> [schema]             Deep crawl following links recursively
  sitemap <url> [schema]             Crawl all URLs from sitemap.xml
  markdown <url>                     Fetch and clean to markdown only (no AI)
  schemas                            List all available schemas

SCHEMAS:
  product     E-commerce product pages
  article     News articles
  job         Job listings
  saas_ideas  AI/SaaS business ideas (blogs, directories)
  blog        Blog posts with tools/companies mentioned
  company     Company/startup profile pages
  pricing     SaaS pricing pages
  review      Review and testimonial pages

FLAGS:
  --output=json,csv,md,jsonl    Output formats (default: json)
  --out-dir=./output            Output directory (default: ./output)
  --depth=3                     Max crawl depth (crawl only, default: 3)
  --pages=50                    Max pages to crawl (default: 50)
  --concurrency=2               Parallel requests (default: 2)
  --delay=500                   Ms delay between requests (default: 500)
  --include=/blog/              Only crawl URLs with this path prefix
  --model=qwen2.5:7b            Ollama model (default: qwen2.5:7b)
  --no-extract                  Skip AI extraction, save markdown only

EXAMPLES:
  npx tsx src/cli.ts scrape https://scrapeme.live/shop/Bulbasaur/ product
  npx tsx src/cli.ts scrape https://n8n.io/pricing pricing --output=json,csv

  npx tsx src/cli.ts crawl https://blog.n8n.io saas_ideas --pages=20 --depth=2
  npx tsx src/cli.ts crawl https://theresanaiforthat.com saas_ideas --pages=30

  npx tsx src/cli.ts sitemap https://n8n.io saas_ideas --include=/blog/ --pages=15
  npx tsx src/cli.ts sitemap https://www.ycombinator.com blog --include=/blog/

  npx tsx src/cli.ts batch https://n8n.io/pricing,https://make.com/en/pricing pricing --output=json,csv,markdown

  npx tsx src/cli.ts markdown https://blog.n8n.io/ai-agents-examples/
`);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdScrape(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }

  const schemaKey = (positional[1] ?? "article") as SchemaKey;
  const model = getFlag(flags, "model", "qwen2.5:7b");
  const formats = getFormats(flags);
  const outDir = getFlag(flags, "out-dir", "./output");

  if (!(schemaKey in SCHEMA_MAP)) {
    console.error(`Unknown schema "${schemaKey}". Run 'schemas' to list available.`);
    process.exit(1);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AI Web Scraper — Single URL`);
  console.log(`  URL:    ${url}`);
  console.log(`  Schema: ${schemaKey}`);
  console.log(`  Model:  ${model}`);
  console.log(`${"═".repeat(60)}`);

  const result = await scrapeOne(url, { schema: schemaKey, model, verbose: true });

  console.log("\n─── EXTRACTED DATA ───────────────────────────────────────");
  console.log(JSON.stringify(result.data, null, 2));
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Tokens: ${result.inputTokens} in / ${result.outputTokens} out | Model: ${result.model}`);

  if (formats.length > 0) {
    console.log("\n─── SAVING OUTPUT ────────────────────────────────────────");
    writeSingleResult(
      {
        url,
        schema: schemaKey,
        model,
        scrapedAt: new Date().toISOString(),
        data: result.data,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
      { dir: outDir, formats }
    );
  }
}

async function cmdBatch(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const urlsRaw = positional[0];
  if (!urlsRaw) { console.error("Error: URLs required (comma-separated)"); process.exit(1); }

  const urls = urlsRaw.split(",").map((u) => u.trim()).filter(Boolean);
  const schemaKey = (positional[1] ?? "article") as SchemaKey;
  const model = getFlag(flags, "model", "qwen2.5:7b");
  const concurrency = parseInt(getFlag(flags, "concurrency", "2"), 10);
  const delay = parseInt(getFlag(flags, "delay", "500"), 10);
  const formats = getFormats(flags);
  const outDir = getFlag(flags, "out-dir", "./output");

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AI Web Scraper — Batch (${urls.length} URLs)`);
  console.log(`  Schema: ${schemaKey} | Model: ${model} | Concurrency: ${concurrency}`);
  console.log(`${"═".repeat(60)}\n`);

  const rawResults = await scrapeBatch(urls, {
    schema: schemaKey,
    model,
    concurrency,
    globalDelayMs: delay,
    retries: 2,
  });

  let totalTokens = 0;
  const batchData = rawResults.map((r) => {
    totalTokens += r.inputTokens + r.outputTokens;
    if (r.status === "success") {
      console.log(`  ✓ ${r.url} (${r.durationMs}ms)`);
      return {
        url: r.url,
        status: "success" as const,
        data: r.data?.result?.data,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        durationMs: r.durationMs,
      };
    } else {
      console.error(`  ✗ ${r.url} → ${r.error}`);
      return {
        url: r.url,
        status: "error" as const,
        error: r.error,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: r.durationMs,
      };
    }
  });

  const successCount = batchData.filter((r) => r.status === "success").length;
  console.log(`\nDone: ${successCount}/${urls.length} succeeded | Tokens: ${totalTokens}`);

  if (formats.length > 0) {
    console.log("\n─── SAVING OUTPUT ────────────────────────────────────────");
    writeBatchResults(
      {
        schema: schemaKey,
        model,
        scrapedAt: new Date().toISOString(),
        totalUrls: urls.length,
        successCount,
        errorCount: urls.length - successCount,
        results: batchData,
      },
      { dir: outDir, formats }
    );
  }
}

async function cmdCrawl(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }

  const schemaKey = (positional[1] ?? "article") as SchemaKey;
  const model = getFlag(flags, "model", "qwen2.5:7b");
  const maxDepth = parseInt(getFlag(flags, "depth", "3"), 10);
  const maxPages = parseInt(getFlag(flags, "pages", "50"), 10);
  const concurrency = parseInt(getFlag(flags, "concurrency", "2"), 10);
  const delay = parseInt(getFlag(flags, "delay", "500"), 10);
  const formats = getFormats(flags);
  const outDir = getFlag(flags, "out-dir", "./output");
  const markdownOnly = flags["no-extract"] === true;
  const includeRaw = getFlag(flags, "include", "");
  const includePattern = includeRaw ? new RegExp(includeRaw.replace(/\//g, "\\/")) : undefined;

  const result = await crawl(url, {
    schema: schemaKey,
    maxDepth,
    maxPages,
    concurrency,
    delayMs: delay,
    model,
    markdownOnly,
    includePattern,
  });

  if (markdownOnly) {
    const pages = result.pages
      .filter((p) => p.status === "success" && p.markdown)
      .map((p) => ({ url: p.url, markdown: p.markdown! }));
    writeMarkdownDump(pages, { dir: outDir });
    return;
  }

  if (formats.length > 0) {
    console.log("─── SAVING OUTPUT ────────────────────────────────────────");
    writeCrawlResults(result, { dir: outDir, formats });
  }
}

async function cmdSitemap(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }

  const schemaKey = (positional[1] ?? "article") as SchemaKey;
  const model = getFlag(flags, "model", "qwen2.5:7b");
  const maxPages = parseInt(getFlag(flags, "pages", "50"), 10);
  const concurrency = parseInt(getFlag(flags, "concurrency", "2"), 10);
  const delay = parseInt(getFlag(flags, "delay", "500"), 10);
  const formats = getFormats(flags);
  const outDir = getFlag(flags, "out-dir", "./output");
  const pathPrefix = getFlag(flags, "include", "");

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AI Web Scraper — Sitemap Mode`);
  console.log(`  Site:   ${url}`);
  console.log(`  Schema: ${schemaKey} | Model: ${model}`);
  console.log(`${"═".repeat(60)}`);

  const sitemapUrls = await discoverSitemapUrls(url, {
    pathPrefix: pathPrefix || undefined,
    maxUrls: maxPages,
  });

  if (sitemapUrls.length === 0) {
    console.error("No URLs found in sitemap. Try --include= flag or check the site's sitemap.");
    process.exit(1);
  }

  console.log(`\nFound ${sitemapUrls.length} URLs to scrape from sitemap.`);

  const urlStrings = sitemapUrls.map((u) => u.loc);

  const rawResults = await scrapeBatch(urlStrings, {
    schema: schemaKey,
    model,
    concurrency,
    globalDelayMs: delay,
    retries: 2,
  });

  let totalTokens = 0;
  const batchData = rawResults.map((r) => {
    totalTokens += r.inputTokens + r.outputTokens;
    if (r.status === "success") {
      console.log(`  ✓ ${r.url}`);
      return {
        url: r.url,
        status: "success" as const,
        data: r.data?.result?.data,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        durationMs: r.durationMs,
      };
    } else {
      return {
        url: r.url,
        status: "error" as const,
        error: r.error,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: r.durationMs,
      };
    }
  });

  const successCount = batchData.filter((r) => r.status === "success").length;
  console.log(`\nDone: ${successCount}/${urlStrings.length} succeeded | Tokens: ${totalTokens}`);

  if (formats.length > 0) {
    console.log("\n─── SAVING OUTPUT ────────────────────────────────────────");
    writeBatchResults(
      {
        schema: schemaKey,
        model,
        scrapedAt: new Date().toISOString(),
        totalUrls: urlStrings.length,
        successCount,
        errorCount: urlStrings.length - successCount,
        results: batchData,
      },
      { dir: outDir, formats }
    );
  }
}

async function cmdMarkdown(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }

  const outDir = getFlag(flags, "out-dir", "./output");

  console.log(`\nFetching: ${url}`);
  const { html } = await fetchPage(url);
  const { markdown, charCount, estimatedTokens } = htmlToMarkdown(html);

  console.log(`→ ${charCount.toLocaleString()} chars | ~${estimatedTokens.toLocaleString()} tokens`);
  console.log("\n" + "─".repeat(60));
  console.log(markdown.slice(0, 2000) + (markdown.length > 2000 ? "\n\n[... truncated in console ...]" : ""));
  console.log("─".repeat(60));

  writeMarkdownDump([{ url, markdown }], { dir: outDir });
}

function cmdSchemas(): void {
  console.log(`\nAvailable schemas:\n`);
  const descriptions: Record<SchemaKey, string> = {
    product:    "E-commerce product pages (name, price, stock, features)",
    article:    "News articles (title, author, summary, key points)",
    job:        "Job listings (title, skills, salary, responsibilities)",
    saas_ideas: "AI/SaaS business ideas from blogs and directories",
    blog:       "Blog posts (tools mentioned, companies, code examples)",
    company:    "Company profiles (funding, products, competitors)",
    pricing:    "SaaS pricing pages (tiers, features, limits)",
    review:     "Review pages (ratings, pros, cons, reviewer details)",
  };

  for (const [key, desc] of Object.entries(descriptions)) {
    console.log(`  ${key.padEnd(12)} ${desc}`);
  }
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);

  switch (command) {
    case "scrape":
      await cmdScrape(positional, flags);
      break;
    case "batch":
      await cmdBatch(positional, flags);
      break;
    case "crawl":
      await cmdCrawl(positional, flags);
      break;
    case "sitemap":
      await cmdSitemap(positional, flags);
      break;
    case "markdown":
      await cmdMarkdown(positional, flags);
      break;
    case "schemas":
      cmdSchemas();
      break;
    case "help":
    default:
      printHelp();
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err.message ?? err);
  process.exit(1);
});
