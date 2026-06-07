/**
 * crawler-v2.ts
 * Deep crawler built on the new pipeline.ts engine.
 */

import { runPipeline, type PipelineOptions, type PipelineResult } from "./pipeline";
import { URL } from "url";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CrawlV2Options extends PipelineOptions {
  maxDepth?: number;
  maxPages?: number;
  delayMs?: number;
  concurrency?: number;
  includePattern?: RegExp;
  excludePattern?: RegExp;
  sameDomainOnly?: boolean;
  onPage?: (result: CrawlV2PageResult) => void | Promise<void>;
}

export interface CrawlV2PageResult {
  url: string;
  depth: number;
  status: "success" | "error";
  result?: PipelineResult;
  error?: string;
  linksFound: number;
  durationMs: number;
}

export interface CrawlV2Result {
  seedUrl: string;
  totalPages: number;
  successCount: number;
  errorCount: number;
  avgConfidence: number;
  durationMs: number;
  pages: CrawlV2PageResult[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SKIP_EXT = /\.(css|js|json|xml|pdf|zip|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|mp4|mp3|exe|dmg)$/i;

function shouldCrawl(url: string, opts: CrawlV2Options, seedDomain: string): boolean {
  if (opts.sameDomainOnly !== false) {
    try {
      if (new URL(url).hostname !== seedDomain) return false;
    } catch { return false; }
  }
  if (opts.includePattern && !opts.includePattern.test(url)) return false;
  if (opts.excludePattern && opts.excludePattern.test(url)) return false;
  if (SKIP_EXT.test(url)) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Extract links from already-parsed data.links array ──────────────────────

function extractLinksFromData(data: unknown, baseUrl: string): string[] {
  const result: string[] = [];
  const linksArr = (data as any)?.links;
  if (!Array.isArray(linksArr)) return result;

  for (const l of linksArr) {
    const href = l?.href ?? l?.url ?? l;
    if (typeof href !== "string") continue;
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    try {
      const abs = new URL(href, baseUrl).href.split("#")[0];
      if (abs.startsWith("http")) result.push(abs);
    } catch { /* skip */ }
  }

  return [...new Set(result)];
}

// ─── Main Crawler ─────────────────────────────────────────────────────────────

export async function crawlV2(seedUrl: string, opts: CrawlV2Options): Promise<CrawlV2Result> {
  const {
    maxDepth = 3,
    maxPages = 50,
    delayMs = 500,
    concurrency = 2,
    onPage,
    verbose = true,
  } = opts;

  const seedDomain = new URL(seedUrl).hostname;
  const visited = new Set<string>([seedUrl]);
  const pages: CrawlV2PageResult[] = [];
  const start = Date.now();

  const queue: Array<[string, number]> = [[seedUrl, 0]];

  const modeLabel = opts.extractionMode ?? "cheerio";
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  CRAWLER v2 — ${modeLabel.toUpperCase()} mode`);
  console.log(`  Seed: ${seedUrl}`);
  console.log(`  Max depth: ${maxDepth} | Max pages: ${maxPages} | Concurrency: ${concurrency}`);
  console.log(`${"─".repeat(60)}\n`);

  async function processPage(url: string, depth: number): Promise<CrawlV2PageResult> {
    const pageStart = Date.now();
    const pageNum = pages.length + 1;
    if (verbose) console.log(`\n  [${pageNum}/${maxPages}] depth=${depth} ${url}`);

    try {
      const result = await runPipeline(url, { ...opts, verbose });

      let linksFound = 0;

      if (depth < maxDepth) {
        const rawLinks = extractLinksFromData(result.data, result.finalUrl);

        for (const link of rawLinks) {
          if (
            !visited.has(link) &&
            shouldCrawl(link, opts, seedDomain) &&
            visited.size < maxPages * 3
          ) {
            visited.add(link);
            queue.push([link, depth + 1]);
            linksFound++;
          }
        }
      }

      const pageResult: CrawlV2PageResult = {
        url,
        depth,
        status: "success",
        result,
        linksFound,
        durationMs: Date.now() - pageStart,
      };

      if (verbose) {
        console.log(
          `      ✓ conf=${(result.confidence * 100).toFixed(0)}% | ${result.fetchMs}ms fetch + ${result.extractMs}ms extract | ${linksFound} new links`
        );
      }

      return pageResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (verbose) console.error(`      ✗ ${msg}`);
      return {
        url,
        depth,
        status: "error",
        error: msg,
        linksFound: 0,
        durationMs: Date.now() - pageStart,
      };
    }
  }

  // BFS with concurrency pool
  while (queue.length > 0 && pages.length < maxPages) {
    const batch: Array<[string, number]> = [];
    while (
      batch.length < concurrency &&
      queue.length > 0 &&
      pages.length + batch.length < maxPages
    ) {
      const item = queue.shift();
      if (item) batch.push(item);
    }
    if (batch.length === 0) break;

    const batchResults = await Promise.all(
      batch.map(([url, depth]) => processPage(url, depth))
    );

    for (const r of batchResults) {
      pages.push(r);
      if (onPage) await onPage(r);
    }

    if (delayMs > 0 && queue.length > 0) await sleep(delayMs);
  }

  const successPages = pages.filter((p) => p.status === "success");
  const avgConfidence =
    successPages.length > 0
      ? successPages.reduce((sum, p) => sum + (p.result?.confidence ?? 0), 0) /
        successPages.length
      : 0;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  CRAWL COMPLETE`);
  console.log(`  Pages: ${pages.length} | Success: ${successPages.length} | Errors: ${pages.length - successPages.length}`);
  console.log(`  Avg confidence: ${(avgConfidence * 100).toFixed(0)}%`);
  console.log(`  Time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`${"─".repeat(60)}\n`);

  return {
    seedUrl,
    totalPages: pages.length,
    successCount: successPages.length,
    errorCount: pages.length - successPages.length,
    avgConfidence,
    durationMs: Date.now() - start,
    pages,
  };
}
