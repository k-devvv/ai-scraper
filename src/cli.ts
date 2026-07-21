#!/usr/bin/env tsx

/**
 * cli.ts — Universal Web Scraper CLI (Phase 1)
 *
 * Commands:
 *   schemas — list all available schemas
 *   scrape <url> <schema> [options] — scrape a single URL
 *   crawl <url> <schema> [options] — deep crawl from a seed URL
 *   sitemap <url> <schema> [options] — scrape all URLs from sitemap
 *   batch <url1,url2,...> <schema> [options] — scrape multiple URLs in parallel
 *
 * Options:
 *   --mode=cheerio|hybrid|ai   extraction mode (default: hybrid)
 *   --pages=N                  max pages (default: 20)
 *   --depth=N                  max link depth (default: 2)
 *   --concurrency=N            parallel workers (default: 2)
 *   --delay=N                  ms between requests (default: 300)
 *   --output=json,csv          save formats (default: json)
 *   --model=qwen2.5:7b         Ollama model for AI/hybrid modes
 *   --threshold=70             hybrid mode: AI kicks in below this confidence %
 */

import * as fs from "fs";
import * as path from "path";
import { runPipeline }                  from "./pipeline";
import type { PipelineMode, PipelineResult } from "./pipeline";   // ← from pipeline, not ./types
import { crawl }                        from "./crawler";
import type { CrawlPageResult }         from "./crawler";         // ← from crawler, not ./types
import { parseSitemap }                 from "./sitemap";
import { saveOutput }                   from "./output";
import { SCHEMA_DESCRIPTIONS }          from "./selectors";

const args    = process.argv.slice(2);
const command = args[0]?.toLowerCase();

function flag(name: string, defaultVal: string): string {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : defaultVal;
}

const outputDir = "output";

async function resolveNlSchema(model: string) {
  const desc = flag("extract", "");
  if (!desc) return undefined;
  const { schemaFromDescription } = await import("./nl-schema");
  console.log(`\n🧠 Generating schema from: "${desc}"`);
  const schema = await schemaFromDescription(desc, model);
  const fields = Object.keys((schema.input_schema as { properties: object }).properties);
  console.log(`   → fields: ${fields.join(", ")}\n`);
  return schema;
}
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
}

// ─── schemas ──────────────────────────────────────────────────────────────────

if (!command || command === "schemas") {
  console.log("\nAvailable schemas (works with --mode=hybrid on ANY site):");
  for (const [name, desc] of Object.entries(SCHEMA_DESCRIPTIONS)) {
    console.log(`  ${name.padEnd(14)} ${desc}`);
  }
  console.log("\nTip: Use --mode=hybrid (default) for 80-90% confidence on any site.");
  console.log("     Use --mode=cheerio for speed on known sites (lower confidence).");
  console.log("     Use --mode=ai for maximum accuracy (slower, uses Ollama).\n");
  process.exit(0);
}

// ─── scrape ───────────────────────────────────────────────────────────────────

if (command === "scrape") {
  const url    = args[1];
  const schema = args[2];

  if (!url || !schema) {
    console.error("Usage: npx tsx src/cli.ts scrape <url> <schema> [--mode=hybrid] [--output=json,csv]");
    process.exit(1);
  }

  const mode          = flag("mode", "hybrid") as PipelineMode;
  const outputFormats = flag("output", "json").split(",");
  const model         = flag("model", "qwen2.5:7b");
  const threshold     = parseInt(flag("threshold", "70"), 10);

  console.log("\n" + "═".repeat(60));
  console.log(` Scraper v3 — Single URL`);
  console.log(` URL:    ${url}`);
  console.log(` Schema: ${schema} | Mode: ${mode}`);
  if (mode === "hybrid") console.log(` AI threshold: <${threshold}% confidence`);
  console.log("═".repeat(60) + "\n");

  (async () => {
    try {
      const nlSchema = await resolveNlSchema(model);
      const result = await runPipeline(url, { schema, mode, model, hybridThreshold: threshold, verbose: true, nlSchema });

      console.log("\n─── EXTRACTED DATA " + "─".repeat(42));
      console.log(JSON.stringify(result.data, null, 2));
      console.log("─".repeat(60));
      console.log(
        `Confidence: ${result.confidence}% | Method: ${result.method} | ${result.totalMs}ms` +
        (result.inputTokens > 0 ? ` | Tokens: ${result.inputTokens}in/${result.outputTokens}out` : "")
      );

      if (outputFormats.length > 0) {
        console.log("\n--- SAVING OUTPUT " + "-".repeat(42));
        await saveOutput(
          [{ url, data: result.data, confidence: result.confidence }],
          schema, outputFormats,
          path.join(outputDir, `scrape_${timestamp()}`)
        );
      }
    } catch (err) {
      console.error(`\nFatal error: ${err instanceof Error ? err.message : err}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      process.exit(1);
    }
  })();
}

// ─── batch ────────────────────────────────────────────────────────────────────

else if (command === "batch") {
  const urlList = args[1];
  const schema  = args[2];

  if (!urlList || !schema) {
    console.error("Usage: npx tsx src/cli.ts batch <url1,url2,...> <schema> [--concurrency=2] [--output=json,csv]");
    process.exit(1);
  }

  const urls = urlList.split(",").map((u) => u.trim()).filter(Boolean);
  const mode          = flag("mode", "hybrid") as PipelineMode;
  const outputFormats = flag("output", "json").split(",");
  const model         = flag("model", "qwen2.5:7b");
  const threshold     = parseInt(flag("threshold", "70"), 10);
  const concurrency   = parseInt(flag("concurrency", "2"), 10);

  console.log("\n" + "═".repeat(60));
  console.log(` Scraper v3 — Batch (${urls.length} URLs, concurrency ${concurrency})`);
  console.log(` Schema: ${schema} | Mode: ${mode}`);
  console.log("═".repeat(60) + "\n");

  (async () => {
    const pLimit = (await import("p-limit")).default;
    const nlSchema = await resolveNlSchema(model);
    const limit = pLimit(concurrency);

    const results = await Promise.all(
      urls.map((url) =>
        limit(async () => {
          try {
            const r = await runPipeline(url, { schema, mode, model, hybridThreshold: threshold, verbose: false, nlSchema });
            console.log(` ✓ ${url} — ${r.confidence}% via ${r.method} (${r.totalMs}ms)`);
            return { url, data: r.data, confidence: r.confidence };
          } catch (err) {
            console.error(` ✗ ${url} — ${err instanceof Error ? err.message : err}`);
            return null;
          }
        })
      )
    );

    const ok = results.filter((r): r is NonNullable<typeof r> => r !== null);
    console.log(`\nDone: ${ok.length}/${urls.length} succeeded`);

    if (ok.length > 0) {
      await saveOutput(ok, schema, outputFormats, path.join(outputDir, `batch_${timestamp()}`));
    }
    process.exit(ok.length > 0 ? 0 : 1);
  })();
}

// ─── crawl ────────────────────────────────────────────────────────────────────

else if (command === "crawl") {
  const seedUrl = args[1];
  const schema  = args[2];

  if (!seedUrl || !schema) {
    console.error("Usage: npx tsx src/cli.ts crawl <url> <schema> [--pages=20] [--depth=2] [--mode=hybrid]");
    process.exit(1);
  }

  const maxPages      = parseInt(flag("pages", "20"), 10);
  const maxDepth      = parseInt(flag("depth", "2"), 10);
  const concurrency   = parseInt(flag("concurrency", "2"), 10);
  const delayMs       = parseInt(flag("delay", "300"), 10);
  const mode          = flag("mode", "hybrid") as PipelineMode;
  const outputFormats = flag("output", "json").split(",");
  const model         = flag("model", "qwen2.5:7b");
  const threshold     = parseInt(flag("threshold", "70"), 10);

  console.log("\n" + "─".repeat(60));
  console.log(` CRAWLER v3 — ${mode.toUpperCase()} mode`);
  console.log(` Seed: ${seedUrl}`);
  console.log(` Max depth: ${maxDepth} | Max pages: ${maxPages} | Concurrency: ${concurrency}`);
  if (mode === "hybrid") console.log(` AI kicks in when Cheerio confidence < ${threshold}%`);
  console.log("─".repeat(60) + "\n");

  (async () => {
    try {
      const nlSchema = await resolveNlSchema(model);
      const summary = await crawl(seedUrl, {
        nlSchema,
        schema, mode, model, hybridThreshold: threshold,
        maxDepth, maxPages, concurrency, delayMs, verbose: true,
      });

      console.log("\n" + "─".repeat(60));
      console.log(` CRAWL COMPLETE`);
      console.log(` Pages: ${summary.pages.length} | Success: ${summary.totalSuccess} | Errors: ${summary.totalErrors}`);
      console.log(` Avg confidence: ${summary.avgConfidence}%`);
      console.log(` Time: ${(summary.totalMs / 1000).toFixed(1)}s`);
      console.log("─".repeat(60));

      const allData = summary.pages
        .filter((p: CrawlPageResult) => p.status === "success" && p.result)
        .map((p: CrawlPageResult) => ({ url: p.url, data: p.result!.data, confidence: p.result!.confidence }));

      if (allData.length === 0) {
        console.log("\n⚠ No successful pages to save.");
        return;
      }

      console.log(`\n─── SAMPLE (first result) ${"─".repeat(34)}`);
      console.log(JSON.stringify(allData[0].data, null, 2));
      console.log("─".repeat(60));

      console.log("\n--- SAVING OUTPUT " + "-".repeat(42));
      await saveOutput(allData, schema, outputFormats, path.join(outputDir, `crawl_${timestamp()}`));

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
  const schema  = args[2];

  if (!siteUrl || !schema) {
    console.error("Usage: npx tsx src/cli.ts sitemap <url> <schema> [--pages=50] [--include=/blog/]");
    process.exit(1);
  }

  const maxPages      = parseInt(flag("pages", "50"), 10);
  const include       = flag("include", "");
  const mode          = flag("mode", "hybrid") as PipelineMode;
  const outputFormats = flag("output", "json").split(",");
  const concurrency   = parseInt(flag("concurrency", "3"), 10);
  const delayMs       = parseInt(flag("delay", "300"), 10);
  const model         = flag("model", "qwen2.5:7b");
  const threshold     = parseInt(flag("threshold", "70"), 10);

  console.log("\n" + "─".repeat(60));
  console.log(` SITEMAP SCRAPER v3 — ${mode.toUpperCase()} mode`);
  console.log(` Site: ${siteUrl}`);
  console.log(` Max pages: ${maxPages} | Filter: ${include || "none"} | Concurrency: ${concurrency}`);
  console.log("─".repeat(60) + "\n");

  (async () => {
    try {
      const nlSchema = await resolveNlSchema(model);
      console.log("[1/3] Discovering URLs from sitemap...");
      let urls = await parseSitemap(siteUrl);
      console.log(` → Found ${urls.length} URLs`);

      if (include) {
        urls = urls.filter((u) => u.includes(include));
        console.log(` → After filter (${include}): ${urls.length} URLs`);
      }

      urls = urls.slice(0, maxPages);
      console.log(` → Scraping ${urls.length} URLs\n`);

      const allData: Array<{ url: string; data: Record<string, unknown>; confidence: number }> = [];
      let success = 0, errors = 0;

      for (let i = 0; i < urls.length; i += concurrency) {
        const batch = urls.slice(i, i + concurrency);
        await Promise.all(batch.map(async (url) => {
          const num = i + batch.indexOf(url) + 1;
          process.stdout.write(` [${num}/${urls.length}] ${url.slice(0, 80)}...`);
          try {
            const result = await runPipeline(url, { schema, mode, model, hybridThreshold: threshold, nlSchema });
            console.log(` ✓ ${result.confidence}% (${result.method})`);
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
        await saveOutput(allData, schema, outputFormats, path.join(outputDir, `sitemap_${timestamp()}`));
      }

    } catch (err) {
      console.error(`\nFatal error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  })();
}

// ─── unknown ──────────────────────────────────────────────────────────────────

else {
  console.error(`Unknown command: "${command}"`);
  console.log("\nCommands: schemas, scrape, crawl, sitemap");
  console.log("\nQuick start:");
  console.log("  npx tsx src/cli.ts scrape https://blog.n8n.io/ai-agents-examples/ saas_ideas");
  console.log("  npx tsx src/cli.ts crawl https://blog.n8n.io saas_ideas --pages=20 --mode=hybrid");
  console.log("  npx tsx src/cli.ts sitemap https://n8n.io saas_ideas --include=/blog/ --pages=50");
  process.exit(1);
}
