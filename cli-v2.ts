#!/usr/bin/env tsx
/**
 * cli-v2.ts — Universal Web Scraper CLI
 *
 * Commands:
 *   schemas                          — list all available schemas
 *   scrape <url> <schema> [options]  — scrape a single URL
 *   crawl  <url> <schema> [options]  — BFS deep crawl from seed URL
 *   sitemap <url> <schema> [options] — scrape all URLs from sitemap.xml
 *
 * Options:
 *   --mode=cheerio|hybrid|ai    default: cheerio
 *   --pages=N                   max pages (default: 20)
 *   --depth=N                   max link depth for crawl (default: 2)
 *   --concurrency=N             parallel workers (default: 3)
 *   --delay=N                   ms between requests (default: 200)
 *   --output=json,csv           save formats (default: json,csv)
 *   --model=qwen2.5:7b          Ollama model
 *   --threshold=N               hybrid AI trigger % override
 *   --include=keyword           URL must contain this string (sitemap filter)
 *                               Examples: --include=blog  --include=use-cases
 *                               DO NOT add leading/trailing slashes — just the keyword
 */

import * as fs from "fs";
import * as path from "path";
import { runPipeline } from "./pipeline";
import { crawl } from "./crawler-v2";
import { parseSitemap } from "./sitemap";
import { saveOutput } from "./output";
import { SCHEMA_DESCRIPTIONS } from "./selectors";
import type { PipelineMode } from "./pipeline";

const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();

function flag(name: string, defaultVal: string): string {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : defaultVal;
}

function flagInt(name: string, defaultVal: number): number {
  return parseInt(flag(name, String(defaultVal)), 10);
}

const outputDir = "output";
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
}

// ─── schemas ──────────────────────────────────────────────────────────────────
if (!command || command === "schemas") {
  console.log("\nAvailable schemas:");
  for (const [name, desc] of Object.entries(SCHEMA_DESCRIPTIONS)) {
    console.log(`  ${name.padEnd(14)} ${desc}`);
  }
  console.log("\nModes:");
  console.log("  cheerio   Fast CSS extraction (default for crawl/sitemap)");
  console.log("  hybrid    Cheerio + Ollama AI fallback (default for scrape)");
  console.log("  ai        Ollama only — maximum accuracy, slowest");
  console.log("\nExamples:");
  console.log("  npx tsx cli-v2.ts crawl https://blog.n8n.io saas_ideas --pages=30 --output=json,csv");
  console.log("  npx tsx cli-v2.ts sitemap https://zapier.com saas_ideas --include=blog --pages=50");
  console.log("  npx tsx cli-v2.ts sitemap https://www.make.com saas_ideas --include=use-cases --pages=30");
  console.log("  npx tsx cli-v2.ts scrape https://scrapeme.live/shop/Bulbasaur/ product\n");
  process.exit(0);
}

// ─── scrape ───────────────────────────────────────────────────────────────────
if (command === "scrape") {
  const url = args[1];
  const schema = args[2];
  if (!url || !schema) {
    console.error("Usage: npx tsx cli-v2.ts scrape <url> <schema> [--mode=hybrid]");
    process.exit(1);
  }

  const mode = flag("mode", "hybrid") as PipelineMode;
  const formats = flag("output", "json,csv").split(",");
  const model = flag("model", "qwen2.5:7b");
  const thresholdRaw = args.find((a) => a.startsWith("--threshold="));
  const threshold = thresholdRaw ? parseInt(thresholdRaw.split("=")[1], 10) : undefined;

  console.log("\n" + "═".repeat(60));
  console.log(`  Scraper v2 — Single URL`);
  console.log(`  URL:    ${url}`);
  console.log(`  Schema: ${schema} | Mode: ${mode}`);
  console.log("═".repeat(60) + "\n");

  (async () => {
    try {
      const result = await runPipeline(url, {
        schema, mode, model,
        ...(threshold !== undefined ? { hybridThreshold: threshold } : {}),
        verbose: true,
      });
      console.log("\n─── EXTRACTED DATA " + "─".repeat(42));
      console.log(JSON.stringify(result.data, null, 2));
      console.log("─".repeat(60));
      console.log(
        `Confidence: ${result.confidence}% | Method: ${result.method} | ${result.totalMs}ms` +
        (result.inputTokens > 0 ? ` | Tokens: ${result.inputTokens}in/${result.outputTokens}out` : "")
      );
      console.log("\n--- SAVING OUTPUT " + "-".repeat(42));
      await saveOutput([{ url, data: result.data, confidence: result.confidence }], schema, formats, path.join(outputDir, `scrape_${ts()}`));
    } catch (err) {
      console.error(`\nFatal error: ${err instanceof Error ? err.message : err}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      process.exit(1);
    }
  })();
}

// ─── crawl ────────────────────────────────────────────────────────────────────
else if (command === "crawl") {
  const seedUrl = args[1];
  const schema = args[2];
  if (!seedUrl || !schema) {
    console.error("Usage: npx tsx cli-v2.ts crawl <url> <schema> [--pages=20] [--depth=2]");
    process.exit(1);
  }

  const maxPages    = flagInt("pages", 20);
  const maxDepth    = flagInt("depth", 2);
  const concurrency = flagInt("concurrency", 3);
  const delayMs     = flagInt("delay", 200);
  const mode        = flag("mode", "cheerio") as PipelineMode;
  const formats     = flag("output", "json,csv").split(",");
  const model       = flag("model", "qwen2.5:7b");
  const thresholdRaw = args.find((a) => a.startsWith("--threshold="));
  const threshold = thresholdRaw ? parseInt(thresholdRaw.split("=")[1], 10) : undefined;

  console.log("\n" + "─".repeat(60));
  console.log(`  CRAWLER v2 — ${mode.toUpperCase()} mode`);
  console.log(`  Seed: ${seedUrl}`);
  console.log(`  Max pages: ${maxPages} | Max depth: ${maxDepth} | Concurrency: ${concurrency}`);
  console.log("─".repeat(60) + "\n");

  (async () => {
    try {
      const summary = await crawl(seedUrl, {
        schema, mode, model,
        ...(threshold !== undefined ? { hybridThreshold: threshold } : {}),
        maxDepth, maxPages, concurrency, delayMs, verbose: true,
      });

      console.log("\n" + "─".repeat(60));
      console.log(`  CRAWL COMPLETE`);
      console.log(`  Pages: ${summary.pages.length} | Success: ${summary.totalSuccess} | Errors: ${summary.totalErrors}`);
      console.log(`  Avg confidence: ${summary.avgConfidence}%`);
      console.log(`  Time: ${(summary.totalMs / 1000).toFixed(1)}s`);
      console.log("─".repeat(60));

      const allData = summary.pages
        .filter((p) => p.status === "success" && p.result)
        .map((p) => ({ url: p.url, data: p.result!.data, confidence: p.result!.confidence }));

      if (allData.length === 0) { console.log("\n⚠ No successful pages."); return; }

      console.log(`\n─── SAMPLE ${"─".repeat(49)}`);
      console.log(JSON.stringify(allData[0].data, null, 2));
      console.log("─".repeat(60));
      console.log("\n--- SAVING OUTPUT " + "-".repeat(42));
      await saveOutput(allData, schema, formats, path.join(outputDir, `crawl_${ts()}`));
    } catch (err) {
      console.error(`\nFatal error: ${err instanceof Error ? err.message : err}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      process.exit(1);
    }
  })();
}

// ─── sitemap ──────────────────────────────────────────────────────────────────
else if (command === "sitemap") {
  const siteUrl = args[1];
  const schema = args[2];
  if (!siteUrl || !schema) {
    console.error("Usage: npx tsx cli-v2.ts sitemap <url> <schema> [--pages=50] [--include=blog]");
    process.exit(1);
  }

  const maxPages    = flagInt("pages", 50);
  // --include accepts a plain keyword like "blog" or "use-cases"
  // It matches if the URL contains that string anywhere
  const includeRaw  = flag("include", "");
  const mode        = flag("mode", "cheerio") as PipelineMode;
  const formats     = flag("output", "json,csv").split(",");
  const concurrency = flagInt("concurrency", 3);
  const delayMs     = flagInt("delay", 200);
  const model       = flag("model", "qwen2.5:7b");
  const thresholdRaw = args.find((a) => a.startsWith("--threshold="));
  const threshold = thresholdRaw ? parseInt(thresholdRaw.split("=")[1], 10) : undefined;

  console.log("\n" + "─".repeat(60));
  console.log(`  SITEMAP SCRAPER — ${mode.toUpperCase()} mode`);
  console.log(`  Site: ${siteUrl} | Max: ${maxPages} | Concurrency: ${concurrency}`);
  if (includeRaw) console.log(`  Filter: URLs containing "${includeRaw}"`);
  console.log("─".repeat(60) + "\n");

  (async () => {
    try {
      console.log("Discovering URLs from sitemap...");
      let urls = await parseSitemap(siteUrl);
      console.log(`  → Found ${urls.length} URLs total`);

      if (includeRaw) {
        // Strip slashes from include value for flexible matching
        // /blog/ → blog, blog/ → blog, /blog → blog
        const keyword = includeRaw.replace(/^\/|\/$/g, "");
        const before = urls.length;
        urls = urls.filter((u) => u.includes(keyword));
        console.log(`  → After filter "${keyword}": ${urls.length} URLs (removed ${before - urls.length})`);

        // Debug: show first 3 non-matching URLs if filter removed everything
        if (urls.length === 0) {
          console.log(`\n  ⚠ Filter "${keyword}" matched nothing. Sample URLs from sitemap:`);
          const allUrls = await parseSitemap(siteUrl);
          allUrls.slice(0, 8).forEach((u) => console.log(`    ${u}`));
          console.log(`  Try --include with part of the URL path shown above.`);
          return;
        }
      }

      // Sort: prefer shorter URLs (index pages last, article pages first)
      urls.sort((a, b) => b.length - a.length);
      urls = urls.slice(0, maxPages);
      console.log(`  → Scraping ${urls.length} URLs\n`);

      const allData: Array<{ url: string; data: Record<string, unknown>; confidence: number }> = [];
      let success = 0, errors = 0;

      for (let i = 0; i < urls.length; i += concurrency) {
        const batch = urls.slice(i, i + concurrency);
        await Promise.all(batch.map(async (url) => {
          const num = i + batch.indexOf(url) + 1;
          process.stdout.write(`  [${num}/${urls.length}] ${url.slice(0, 70)}...`);
          try {
            const result = await runPipeline(url, {
              schema, mode, model,
              ...(threshold !== undefined ? { hybridThreshold: threshold } : {}),
            });
            console.log(` ✓ ${result.confidence}% (${result.method}) ${result.totalMs}ms`);
            allData.push({ url, data: result.data, confidence: result.confidence });
            success++;
          } catch (err) {
            console.log(` ✗ ${err instanceof Error ? err.message : err}`);
            errors++;
          }
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        }));
      }

      console.log(`\n  Done: ${success} success | ${errors} errors`);

      if (allData.length > 0) {
        console.log(`\n─── SAMPLE ${"─".repeat(49)}`);
        console.log(JSON.stringify(allData[0].data, null, 2));
        console.log("\n--- SAVING OUTPUT " + "-".repeat(42));
        await saveOutput(allData, schema, formats, path.join(outputDir, `sitemap_${ts()}`));
      }
    } catch (err) {
      console.error(`\nFatal error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  })();
}

else {
  console.error(`Unknown command: "${command}"`);
  console.log("\nCommands: schemas, scrape, crawl, sitemap");
  process.exit(1);
}
