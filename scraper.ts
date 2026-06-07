/**
 * scraper.ts
 * Main pipeline entry point — 100% local, zero API cost.
 *
 * Pipeline stages (per URL):
 *   1. fetchPage()         → Stealth Playwright browser → raw HTML
 *   2. htmlToMarkdown()    → Turndown noise-stripped Markdown
 *   3. extractWithOllama() → Local Ollama JSON schema extraction → typed JSON
 */

import { fetchPage, type BrowserOptions } from "./browser";
import { htmlToMarkdown } from "./cleaner";
import { extractWithOllama, type ExtractResult, type OllamaSchema } from "./extractor";
import { runQueue, type ScrapeJob, type ScrapeResult } from "./queue";
import { SCHEMA_MAP, type SchemaKey } from "./schemas";

// ─── Single-URL scraper ───────────────────────────────────────────────────────

export interface ScrapeOptions {
  schema: SchemaKey | OllamaSchema;
  browser?: BrowserOptions;
  model?: string;
  verbose?: boolean;
}

export async function scrapeOne<T = Record<string, unknown>>(
  url: string,
  opts: ScrapeOptions
): Promise<ExtractResult<T> & { url: string; finalUrl: string }> {
  const {
    schema,
    browser: browserOpts = {},
    model = "qwen2.5:7b",
    verbose = true,
  } = opts;

  const resolvedSchema: OllamaSchema =
    typeof schema === "string" ? SCHEMA_MAP[schema] : schema;

  if (verbose) console.log(`\n[1/3] Fetching: ${url}`);
  const { html, finalUrl, statusCode } = await fetchPage(url, browserOpts);
  if (verbose)
    console.log(
      `      → ${html.length.toLocaleString()} HTML chars | HTTP ${statusCode ?? "?"} | final URL: ${finalUrl}`
    );

  if (verbose) console.log(`[2/3] Cleaning DOM → Markdown`);
  const { markdown, charCount, estimatedTokens } = htmlToMarkdown(html);
  if (verbose)
    console.log(
      `      → ${charCount.toLocaleString()} chars | ~${estimatedTokens.toLocaleString()} tokens`
    );

  if (verbose) console.log(`[3/3] Extracting with Ollama (${model})`);
  const result = await extractWithOllama<T>(markdown, resolvedSchema, model);
  if (verbose)
    console.log(
      `      → ${result.inputTokens} in / ${result.outputTokens} out tokens | truncated: ${result.truncated}`
    );

  return { ...result, url, finalUrl };
}

// ─── Batch scraper ────────────────────────────────────────────────────────────

export interface BatchOptions extends ScrapeOptions {
  concurrency?: number;
  retries?: number;
  globalDelayMs?: number;
}

export async function scrapeBatch<T = Record<string, unknown>>(
  urls: string[],
  opts: BatchOptions
): Promise<ScrapeResult<{ result: ExtractResult<T>; finalUrl: string }>[]> {
  const { concurrency = 3, retries = 2, globalDelayMs = 0, ...scrapeOpts } = opts;

  const jobs: ScrapeJob[] = urls.map((url) => ({
    url,
    delayMs: globalDelayMs || undefined,
  }));

  return runQueue<{ result: ExtractResult<T>; finalUrl: string }>(
    jobs,
    async (url) => {
      const { finalUrl, inputTokens, outputTokens, ...rest } = await scrapeOne<T>(
        url,
        { ...scrapeOpts, verbose: false }
      );
      return {
        data: { result: { ...rest, inputTokens, outputTokens }, finalUrl },
        inputTokens,
        outputTokens,
      };
    },
    { concurrency, retries }
  );
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const targetUrl = process.argv[2] ?? "https://scrapeme.live/shop/Bulbasaur/";
  const schemaKey = (process.argv[3] as SchemaKey) ?? "product";
  const model = process.argv[4] ?? "qwen2.5:7b";

  console.log("=".repeat(60));
  console.log(`  AI Web Scraper (Ollama — fully local)`);
  console.log(`  URL:    ${targetUrl}`);
  console.log(`  Schema: ${schemaKey}`);
  console.log(`  Model:  ${model}`);
  console.log("=".repeat(60));

  const result = await scrapeOne(targetUrl, {
    schema: schemaKey,
    model,
    verbose: true,
  });

  console.log("\n─── EXTRACTED DATA ─────────────────────────────────────");
  console.log(JSON.stringify(result.data, null, 2));
  console.log("─────────────────────────────────────────────────────────");
  console.log(
    `\nTokens: ${result.inputTokens} in / ${result.outputTokens} out | Model: ${result.model}`
  );
}

if (require.main === module || import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}