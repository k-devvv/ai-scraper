#!/usr/bin/env node
/**
 * cli-v2.ts — Full CLI with crawl exclude fix
 */

import { runPipeline, runBatchPipeline, type ExtractionMode } from "./pipeline";
import { crawlV2 } from "./crawler-v2";
import { discoverSitemapUrls } from "./sitemap";
import {
  writeSingleResult,
  writeBatchResults,
  writeCrawlResults,
  writeMarkdownDump,
  type OutputFormat,
} from "./output";
import { SCHEMA_MAP, type SchemaKey } from "./schemas";
import type { FetchMode } from "./fetcher";

// ─── Arg Parser ───────────────────────────────────────────────────────────────

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
      const [k, v] = arg.slice(2).split("=");
      flags[k] = v ?? true;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

function str(flags: Record<string, string | boolean>, key: string, fallback: string): string {
  const v = flags[key];
  return typeof v === "string" ? v : fallback;
}

function num(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  return parseInt(str(flags, key, String(fallback)), 10) || fallback;
}

function formats(flags: Record<string, string | boolean>): OutputFormat[] {
  return str(flags, "output", "json").split(",").map((f) => f.trim() as OutputFormat);
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
AI Web Scraper v2 - Cheerio + Intercept + AI

COMMANDS:
  scrape    <url> [schema]        Single URL
  batch     <url1,url2> [schema]  Multiple URLs (comma-separated)
  crawl     <url> [schema]        Deep recursive crawl
  sitemap   <url> [schema]        Crawl via sitemap.xml
  intercept <url>                 Steal JSON from page APIs
  markdown  <url>                 Clean markdown dump
  compare   <url> [schema]        Compare all modes
  schemas                         List all schemas

FLAGS:
  --mode=cheerio|hybrid|ai        Extraction mode (default: cheerio)
  --fetch=auto|fast|stealth       Fetch mode (default: auto)
  --output=json,csv,markdown      Save formats (default: json)
  --out-dir=./output              Output directory
  --depth=3                       Max crawl depth
  --pages=50                      Max pages
  --concurrency=3                 Parallel requests
  --delay=500                     Ms between requests
  --include=/blog/                URL path filter
  --model=qwen2.5:7b              Ollama model
  --threshold=0.3                 Hybrid AI trigger confidence
  --proxy=http://...              Proxy URL

EXAMPLES:
  npx tsx cli-v2.ts scrape https://scrapeme.live/shop/Bulbasaur/ product
  npx tsx cli-v2.ts crawl https://blog.n8n.io article --pages=20 --output=json,csv
  npx tsx cli-v2.ts batch https://n8n.io/pricing,https://make.com/en/pricing pricing
  npx tsx cli-v2.ts intercept https://producthunt.com/topics/ai-agents
`);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdScrape(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }

  const schema = positional[1] ?? "article";
  const mode = str(flags, "mode", "cheerio") as ExtractionMode;
  const fetchMode = str(flags, "fetch", "auto") as FetchMode;
  const model = str(flags, "model", "qwen2.5:7b");
  const threshold = parseFloat(str(flags, "threshold", "0.3"));
  const proxy = str(flags, "proxy", "");
  const outDir = str(flags, "out-dir", "./output");
  const fmts = formats(flags);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Scraper v2 - Single URL`);
  console.log(`  URL:    ${url}`);
  console.log(`  Schema: ${schema} | Mode: ${mode} | Fetch: ${fetchMode}`);
  console.log(`${"=".repeat(60)}`);

  const result = await runPipeline(url, {
    schema,
    extractionMode: mode,
    fetchMode,
    model,
    aiThreshold: threshold,
    proxy: proxy || undefined,
    verbose: true,
  });

  console.log("\n--- EXTRACTED DATA -------------------------------------------");
  console.log(JSON.stringify(result.data, null, 2));
  console.log("--------------------------------------------------------------");
  console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}% | AI fallback: ${result.usedAiFallback}`);
  console.log(`Fetch: ${result.fetchMs}ms | Extract: ${result.extractMs}ms | Total: ${result.durationMs}ms`);

  if (result.interceptedData && result.interceptedData.length > 0) {
    console.log(`\n--- INTERCEPTED API DATA (${result.interceptedData.length} responses) ---`);
    console.log(JSON.stringify(result.interceptedData[0], null, 2));
  }

  if (fmts.length > 0) {
    console.log("\n--- SAVING OUTPUT --------------------------------------------");
    writeSingleResult(
      {
        url,
        schema,
        model: mode,
        scrapedAt: new Date().toISOString(),
        data: result.data,
        inputTokens: 0,
        outputTokens: 0,
      },
      { dir: outDir, formats: fmts }
    );
  }
}

async function cmdIntercept(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }

  const outDir = str(flags, "out-dir", "./output");
  const fmts = formats(flags);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Network Intercept Mode`);
  console.log(`  URL: ${url}`);
  console.log(`  -> Launching stealth browser and tapping API calls...`);
  console.log(`${"=".repeat(60)}`);

  const result = await runPipeline(url, {
    schema: "generic",
    extractionMode: "intercept",
    fetchMode: "intercept",
    verbose: true,
  });

  if (result.interceptedData && result.interceptedData.length > 0) {
    console.log(`\n--- INTERCEPTED ${result.interceptedData.length} API RESPONSE(S) ---`);
    result.interceptedData.forEach((d, i) => {
      console.log(`\n[${i + 1}]`, JSON.stringify(d, null, 2).slice(0, 1000));
    });
  } else {
    console.log("\nNo JSON API calls intercepted. The site may serve data in HTML.");
    console.log("Try: npx tsx cli-v2.ts scrape <url> --mode=cheerio instead.");
  }

  if (fmts.length > 0 && result.interceptedData && result.interceptedData.length > 0) {
    writeSingleResult(
      {
        url,
        schema: "intercept",
        model: "intercept",
        scrapedAt: new Date().toISOString(),
        data: { intercepted: result.interceptedData, page_data: result.data },
        inputTokens: 0,
        outputTokens: 0,
      },
      { dir: outDir, formats: fmts }
    );
  }
}

async function cmdBatch(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const urlsRaw = positional[0];
  if (!urlsRaw) { console.error("Error: URLs required"); process.exit(1); }

  const urls = urlsRaw.split(",").map((u) => u.trim()).filter(Boolean);
  const schema = positional[1] ?? "article";
  const mode = str(flags, "mode", "cheerio") as ExtractionMode;
  const fetchMode = str(flags, "fetch", "auto") as FetchMode;
  const concurrency = num(flags, "concurrency", 3);
  const delay = num(flags, "delay", 500);
  const outDir = str(flags, "out-dir", "./output");
  const fmts = formats(flags);
  const model = str(flags, "model", "qwen2.5:7b");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Scraper v2 - Batch (${urls.length} URLs)`);
  console.log(`  Schema: ${schema} | Mode: ${mode} | Concurrency: ${concurrency}`);
  console.log(`${"=".repeat(60)}\n`);

  const results = await runBatchPipeline(urls, {
    schema,
    extractionMode: mode,
    fetchMode,
    model,
    concurrency,
    delayMs: delay,
    retries: 2,
    verbose: true,
  });

  const successes = results.filter((r) => r.status === "success");
  const errors = results.filter((r) => r.status === "error");

  console.log(`\nDone: ${successes.length}/${urls.length} succeeded`);
  if (errors.length > 0) {
    errors.forEach((e) => console.error(`  x ${e.url}: ${e.error}`));
  }

  if (fmts.length > 0) {
    console.log("\n--- SAVING OUTPUT --------------------------------------------");
    writeBatchResults(
      {
        schema,
        model: mode,
        scrapedAt: new Date().toISOString(),
        totalUrls: urls.length,
        successCount: successes.length,
        errorCount: errors.length,
        results: results.map((r) => ({
          url: r.url,
          status: r.status,
          data: r.result?.data,
          error: r.error,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: r.durationMs,
        })),
      },
      { dir: outDir, formats: fmts }
    );
  }
}

async function cmdCrawl(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }

  const schema = positional[1] ?? "article";
  const mode = str(flags, "mode", "cheerio") as ExtractionMode;
  const fetchMode = str(flags, "fetch", "auto") as FetchMode;
  const maxDepth = num(flags, "depth", 3);
  const maxPages = num(flags, "pages", 50);
  const concurrency = num(flags, "concurrency", 2);
  const delay = num(flags, "delay", 500);
  const outDir = str(flags, "out-dir", "./output");
  const fmts = formats(flags);
  const model = str(flags, "model", "qwen2.5:7b");
  const includeRaw = str(flags, "include", "");
  const includePattern = includeRaw ? new RegExp(includeRaw.replace(/\//g, "\\/")) : undefined;

  // Always exclude tag/author/page listing URLs
  const excludePattern = /\/(tag|author|page)\//;

  const result = await crawlV2(url, {
    schema,
    extractionMode: mode,
    fetchMode,
    model,
    maxDepth,
    maxPages,
    concurrency,
    delayMs: delay,
    includePattern,
    excludePattern,
    verbose: true,
  });

  if (fmts.length > 0) {
    console.log("--- SAVING OUTPUT --------------------------------------------");
    writeCrawlResults(
      {
        seedUrl: url,
        totalPages: result.totalPages,
        successCount: result.successCount,
        errorCount: result.errorCount,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        durationMs: result.durationMs,
        pages: result.pages.map((p) => ({
          url: p.url,
          depth: p.depth,
          status: p.status,
          data: p.result?.data,
          error: p.error,
          markdown: p.result?.markdown,
          linksFound: p.linksFound,
          durationMs: p.durationMs,
        })),
      },
      { dir: outDir, formats: fmts }
    );
  }
}

async function cmdSitemap(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }

  const schema = positional[1] ?? "article";
  const mode = str(flags, "mode", "cheerio") as ExtractionMode;
  const fetchMode = str(flags, "fetch", "auto") as FetchMode;
  const maxPages = num(flags, "pages", 50);
  const concurrency = num(flags, "concurrency", 3);
  const delay = num(flags, "delay", 500);
  const outDir = str(flags, "out-dir", "./output");
  const fmts = formats(flags);
  const model = str(flags, "model", "qwen2.5:7b");
  const pathPrefix = str(flags, "include", "");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Scraper v2 - Sitemap Mode`);
  console.log(`  Site: ${url} | Schema: ${schema} | Mode: ${mode}`);
  console.log(`${"=".repeat(60)}`);

  const sitemapUrls = await discoverSitemapUrls(url, {
    pathPrefix: pathPrefix || undefined,
    maxUrls: maxPages,
  });

  if (sitemapUrls.length === 0) {
    console.error("No URLs found in sitemap.");
    process.exit(1);
  }

  console.log(`\nFound ${sitemapUrls.length} URLs from sitemap.\n`);
  const urlStrings = sitemapUrls.map((u) => u.loc);

  const results = await runBatchPipeline(urlStrings, {
    schema,
    extractionMode: mode,
    fetchMode,
    model,
    concurrency,
    delayMs: delay,
    retries: 2,
    verbose: true,
  });

  const successes = results.filter((r) => r.status === "success");
  console.log(`\nDone: ${successes.length}/${urlStrings.length} succeeded`);

  if (fmts.length > 0) {
    console.log("\n--- SAVING OUTPUT --------------------------------------------");
    writeBatchResults(
      {
        schema,
        model: mode,
        scrapedAt: new Date().toISOString(),
        totalUrls: urlStrings.length,
        successCount: successes.length,
        errorCount: urlStrings.length - successes.length,
        results: results.map((r) => ({
          url: r.url,
          status: r.status,
          data: r.result?.data,
          error: r.error,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: r.durationMs,
        })),
      },
      { dir: outDir, formats: fmts }
    );
  }
}

async function cmdMarkdown(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }

  const outDir = str(flags, "out-dir", "./output");
  const fetchMode = str(flags, "fetch", "auto") as FetchMode;

  const result = await runPipeline(url, {
    schema: "generic",
    extractionMode: "markdown",
    fetchMode,
    verbose: true,
  });

  console.log("\n--- MARKDOWN -------------------------------------------------");
  const md = (result.data as any).markdown ?? "";
  console.log(md.slice(0, 3000) + (md.length > 3000 ? "\n\n[... truncated ...]" : ""));

  writeMarkdownDump([{ url, markdown: md }], { dir: outDir });
}

async function cmdCompare(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const url = positional[0];
  if (!url) { console.error("Error: URL required"); process.exit(1); }
  const schema = positional[1] ?? "product";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  MODE COMPARISON`);
  console.log(`  URL: ${url} | Schema: ${schema}`);
  console.log(`${"=".repeat(60)}\n`);

  const modes: ExtractionMode[] = ["cheerio", "intercept"];

  for (const mode of modes) {
    console.log(`\n-- ${mode.toUpperCase()} ------------------------------------------`);
    try {
      const result = await runPipeline(url, {
        schema,
        extractionMode: mode,
        fetchMode: mode === "intercept" ? "intercept" : "auto",
        verbose: false,
      });
      console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}% | Time: ${result.durationMs}ms`);
      console.log(JSON.stringify(result.data, null, 2).slice(0, 800));
    } catch (err) {
      console.error(`Failed: ${err}`);
    }
  }
}

function cmdSchemas(): void {
  const descriptions: Record<string, string> = {
    product:    "E-commerce pages (price, stock, features, images)",
    article:    "News articles (title, author, date, key points)",
    job:        "Job listings (title, skills, salary, responsibilities)",
    saas_ideas: "AI/SaaS idea blogs and directories",
    blog:       "Blog posts (tools, companies, code examples)",
    company:    "Company profiles (funding, products, competitors)",
    pricing:    "SaaS pricing pages (tiers, features, limits)",
    review:     "Review pages (ratings, pros, cons)",
  };

  console.log(`\nAvailable schemas:\n`);
  for (const [k, v] of Object.entries(descriptions)) {
    console.log(`  ${k.padEnd(12)} ${v}`);
  }
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);

  switch (command) {
    case "scrape":    await cmdScrape(positional, flags); break;
    case "intercept": await cmdIntercept(positional, flags); break;
    case "batch":     await cmdBatch(positional, flags); break;
    case "crawl":     await cmdCrawl(positional, flags); break;
    case "sitemap":   await cmdSitemap(positional, flags); break;
    case "markdown":  await cmdMarkdown(positional, flags); break;
    case "compare":   await cmdCompare(positional, flags); break;
    case "schemas":   cmdSchemas(); break;
    case "help":
    default:          printHelp();
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err.message ?? err);
  process.exit(1);
});
