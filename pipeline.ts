/**
 * pipeline.ts
 * Unified scraping pipeline — Traditional + Optional AI fallback.
 *
 * Extraction order:
 *  1. Fetch page (Axios fast / Playwright stealth / Network intercept)
 *  2. Cheerio CSS extraction (instant, zero cost)
 *  3. If intercept mode captured JSON → merge it in
 *  4. [Optional] If confidence < threshold → fall back to Ollama AI
 *
 * This gives you the best of both worlds:
 *  - Speed and zero cost for standard pages
 *  - AI fallback for messy/dynamic pages that CSS can't parse
 */

import { fetchPage, type FetchOptions, type FetchMode } from "./fetcher";
import { extractWithCheerio, type CheerioResult } from "./extractor-cheerio";
import { htmlToMarkdown } from "./cleaner";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExtractionMode = "cheerio" | "ai" | "hybrid" | "intercept" | "markdown";

export interface PipelineOptions {
  /** Which schema to extract (product, article, job, saas_ideas, etc.) */
  schema: string;
  /** Extraction engine */
  extractionMode?: ExtractionMode;
  /** Fetch mode */
  fetchMode?: FetchMode;
  /** Proxy URL */
  proxy?: string;
  /** Timeout in ms */
  timeoutMs?: number;
  /** For intercept mode */
  interceptPattern?: RegExp;
  /** Ollama model (used only in ai/hybrid modes) */
  model?: string;
  /** Confidence threshold below which hybrid mode triggers AI (0-1) */
  aiThreshold?: number;
  /** Verbose logging */
  verbose?: boolean;
}

export interface PipelineResult<T = Record<string, unknown>> {
  url: string;
  finalUrl: string;
  schema: string;
  extractionMode: ExtractionMode;
  fetchMode: FetchMode;
  data: T;
  markdown?: string;
  confidence: number;
  usedAiFallback: boolean;
  structuredData: unknown[];
  interceptedData?: unknown[];
  statusCode: number | null;
  durationMs: number;
  fetchMs: number;
  extractMs: number;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export async function runPipeline<T = Record<string, unknown>>(
  url: string,
  opts: PipelineOptions
): Promise<PipelineResult<T>> {
  const {
    schema,
    extractionMode = "cheerio",
    fetchMode = "auto",
    proxy,
    timeoutMs = 30_000,
    interceptPattern,
    model = "qwen2.5:7b",
    aiThreshold = 0.6,
    verbose = true,
  } = opts;

  const totalStart = Date.now();

  // ── Step 1: Fetch ──────────────────────────────────────────────────────────

  const fetchOpts: FetchOptions = {
    mode: extractionMode === "intercept" ? "intercept" : fetchMode,
    proxy,
    timeoutMs,
    interceptPattern,
  };

  if (verbose) console.log(`[1/3] Fetching (${fetchOpts.mode}): ${url}`);
  const fetchStart = Date.now();
  const fetched = await fetchPage(url, fetchOpts);
  const fetchMs = Date.now() - fetchStart;

  if (verbose) {
    console.log(
      `      → ${fetched.html.length.toLocaleString()} chars | HTTP ${fetched.statusCode ?? "?"} | ${fetchMs}ms | mode: ${fetched.mode}`
    );
    if (fetched.interceptedJson && fetched.interceptedJson.length > 0) {
      console.log(`      → Intercepted ${fetched.interceptedJson.length} API response(s)`);
    }
  }

  // ── Step 2: Extract ────────────────────────────────────────────────────────

  let data: Record<string, unknown> = {};
  let confidence = 0;
  let structuredData: unknown[] = [];
  let interceptedData: unknown[] | undefined;
  let usedAiFallback = false;
  let markdown: string | undefined;
  const extractStart = Date.now();

  if (verbose) console.log(`[2/3] Extracting with Cheerio (schema: ${schema})`);

  const cheerioResult: CheerioResult = extractWithCheerio(
    fetched.html,
    schema,
    fetched.interceptedJson
  );

  data = cheerioResult.data as Record<string, unknown>;
  confidence = cheerioResult.confidence;
  structuredData = cheerioResult.structuredData;
  interceptedData = cheerioResult.interceptedData;

  if (verbose) {
    console.log(
      `      → Confidence: ${(confidence * 100).toFixed(0)}% | Found: [${cheerioResult.fieldStats.found.join(", ")}]`
    );
    if (cheerioResult.fieldStats.missing.length > 0) {
      console.log(`      → Missing:    [${cheerioResult.fieldStats.missing.join(", ")}]`);
    }
  }

  // ── Step 3: AI fallback (hybrid mode only) ─────────────────────────────────

  if (extractionMode === "hybrid" && confidence < aiThreshold) {
    if (verbose) {
      console.log(
        `[3/3] Confidence ${(confidence * 100).toFixed(0)}% < ${(aiThreshold * 100).toFixed(0)}% threshold → falling back to Ollama AI`
      );
    }

    try {
      const { htmlToMarkdown: clean } = await import("./cleaner");
      const { SCHEMA_MAP } = await import("./schemas");
      const { extractWithOllama } = await import("./extractor");

      const { markdown: md } = clean(fetched.html);
      markdown = md;

      const schemaObj = (SCHEMA_MAP as Record<string, unknown>)[schema];
      if (schemaObj) {
        const aiResult = await extractWithOllama(md, schemaObj as any, model);
        // Merge AI result over cheerio (AI wins on conflict)
        data = { ...data, ...((aiResult.data as Record<string, unknown>) ?? {}) };
        confidence = Math.max(confidence, 0.7); // trust AI result
        usedAiFallback = true;
        if (verbose) console.log(`      → AI extraction complete`);
      }
    } catch (err) {
      if (verbose) console.warn(`      → AI fallback failed: ${err}`);
    }
  }

  // ── Markdown mode: always produce clean markdown ───────────────────────────

  if (extractionMode === "markdown" || opts.extractionMode === "markdown") {
    const { markdown: md } = htmlToMarkdown(fetched.html);
    markdown = md;
    data = { markdown: md, url, title: data.title ?? null };
    confidence = 1;
  }

  const extractMs = Date.now() - extractStart;

  if (verbose) {
    console.log(
      `      → Extraction done in ${extractMs}ms${usedAiFallback ? " (with AI fallback)" : ""}`
    );
  }

  return {
    url,
    finalUrl: fetched.finalUrl,
    schema,
    extractionMode,
    fetchMode: fetched.mode,
    data: data as T,
    markdown,
    confidence,
    usedAiFallback,
    structuredData,
    interceptedData,
    statusCode: fetched.statusCode,
    durationMs: Date.now() - totalStart,
    fetchMs,
    extractMs,
  };
}

// ─── Batch pipeline ───────────────────────────────────────────────────────────

export interface BatchPipelineOptions extends PipelineOptions {
  concurrency?: number;
  delayMs?: number;
  retries?: number;
  onPage?: (result: PipelineResult, index: number, total: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  label: string
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        const wait = 1500 * (i + 1) + Math.random() * 500;
        console.warn(`  [retry ${i + 1}/${retries}] ${label} in ${Math.round(wait)}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

export interface BatchPipelineResult<T = Record<string, unknown>> {
  url: string;
  status: "success" | "error";
  result?: PipelineResult<T>;
  error?: string;
  durationMs: number;
}

export async function runBatchPipeline<T = Record<string, unknown>>(
  urls: string[],
  opts: BatchPipelineOptions
): Promise<BatchPipelineResult<T>[]> {
  const { concurrency = 3, delayMs = 500, retries = 2, onPage, verbose = false } = opts;

  const results: BatchPipelineResult<T>[] = [];
  const queue = [...urls];
  let active = 0;
  let completed = 0;

  return new Promise((resolve) => {
    function next() {
      while (active < concurrency && queue.length > 0) {
        const url = queue.shift()!;
        active++;
        const start = Date.now();

        const run = async () => {
          if (delayMs > 0 && completed > 0) await sleep(delayMs);
          try {
            const result = await withRetry(
              () => runPipeline<T>(url, { ...opts, verbose: false }),
              retries,
              url
            );
            const batchResult: BatchPipelineResult<T> = {
              url,
              status: "success",
              result,
              durationMs: Date.now() - start,
            };
            results.push(batchResult);
            completed++;
            if (verbose) console.log(`  ✓ [${completed}/${urls.length}] ${url} (${batchResult.durationMs}ms)`);
            if (onPage) onPage(result, completed, urls.length);
          } catch (err) {
            const batchResult: BatchPipelineResult<T> = {
              url,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - start,
            };
            results.push(batchResult);
            completed++;
            if (verbose) console.error(`  ✗ [${completed}/${urls.length}] ${url} → ${batchResult.error}`);
          } finally {
            active--;
            if (queue.length === 0 && active === 0) resolve(results);
            else next();
          }
        };

        run();
      }
    }

    if (urls.length === 0) return resolve([]);
    next();
  });
}
