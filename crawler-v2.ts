/**
 * crawler-v2.ts
 * BFS deep crawler using the cheerio/hybrid pipeline.
 */

import * as http from "http";
import * as https from "https";
import { runPipeline } from "./pipeline";
import type { PipelineOptions, PipelineResult } from "./pipeline";

export interface CrawlOptions extends PipelineOptions {
  maxDepth?: number;
  maxPages?: number;
  concurrency?: number;
  delayMs?: number;
  retries?: number;
}

export interface CrawlPageResult {
  url: string;
  depth: number;
  status: "success" | "error";
  result?: PipelineResult;
  error?: string;
  durationMs: number;
}

export interface CrawlSummary {
  pages: CrawlPageResult[];
  totalSuccess: number;
  totalErrors: number;
  avgConfidence: number;
  totalMs: number;
}

export async function crawl(
  seedUrl: string,
  opts: CrawlOptions
): Promise<CrawlSummary> {
  const maxDepth = opts.maxDepth ?? 2;
  const maxPages = opts.maxPages ?? 20;
  const concurrency = opts.concurrency ?? 2;
  const delayMs = opts.delayMs ?? 300;
  const retries = opts.retries ?? 1;

  const seedOrigin = getOrigin(seedUrl);
  if (!seedOrigin) throw new Error(`Invalid seed URL: ${seedUrl}`);

  const visited = new Set<string>();
  const results: CrawlPageResult[] = [];

  const queue: Array<[string, number]> = [[normalizeUrl(seedUrl), 0]];
  visited.add(normalizeUrl(seedUrl));

  const overallStart = Date.now();
  let pageCount = 0;

  while (queue.length > 0 && pageCount < maxPages) {
    const batch: Array<[string, number]> = [];
    while (batch.length < concurrency && queue.length > 0 && pageCount + batch.length < maxPages) {
      const item = queue.shift();
      if (item) batch.push(item);
    }

    await Promise.all(
      batch.map(async ([url, depth]) => {
        pageCount++;
        const pageNum = pageCount;
        console.log(`\n  [${pageNum}/${maxPages}] depth=${depth} ${url}`);

        const pageStart = Date.now();
        let pageResult: CrawlPageResult;

        try {
          const result = await withRetry(
            () => runPipeline(url, { ...opts, verbose: true }),
            retries
          );

          const newLinks = await discoverLinks(url, seedOrigin, visited, maxDepth, depth);
          let addedCount = 0;
          for (const link of newLinks) {
            if (!visited.has(link) && pageCount + queue.length < maxPages * 3) {
              visited.add(link);
              queue.push([link, depth + 1]);
              addedCount++;
            }
          }

          console.log(
            `      ✓ conf=${result.confidence}% | ${result.fetchMs}ms fetch + ${result.extractMs}ms extract | ${addedCount} new links`
          );

          pageResult = {
            url,
            depth,
            status: "success",
            result,
            durationMs: Date.now() - pageStart,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`      ✗ ${msg}`);
          pageResult = {
            url,
            depth,
            status: "error",
            error: msg,
            durationMs: Date.now() - pageStart,
          };
        }

        results.push(pageResult);
        if (delayMs > 0) await sleep(delayMs);
      })
    );
  }

  const successes = results.filter((r) => r.status === "success");
  const confidences = successes
    .map((r) => r.result?.confidence ?? 0)
    .filter((c) => c > 0);
  const avgConfidence =
    confidences.length > 0
      ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
      : 0;

  return {
    pages: results,
    totalSuccess: successes.length,
    totalErrors: results.length - successes.length,
    avgConfidence,
    totalMs: Date.now() - overallStart,
  };
}

// ─── Link discovery ───────────────────────────────────────────────────────────
async function discoverLinks(
  pageUrl: string,
  allowedOrigin: string,
  visited: Set<string>,
  maxDepth: number,
  currentDepth: number
): Promise<string[]> {
  if (currentDepth >= maxDepth) return [];

  try {
    const html = await fetchRaw(pageUrl);
    const links: string[] = [];
    const hrefRegex = /href=["']([^"'#][^"']*?)["']/gi;
    let match: RegExpExecArray | null;

    while ((match = hrefRegex.exec(html)) !== null) {
      const href = match[1];
      let resolved: string;

      if (href.startsWith("http")) {
        resolved = href;
      } else if (href.startsWith("/")) {
        resolved = allowedOrigin + href;
      } else {
        continue;
      }

      let normalized: string;
      try {
        normalized = normalizeUrl(resolved);
      } catch {
        continue;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(normalized);
      } catch {
        continue;
      }

      const pathname = parsedUrl.pathname;

      // Skip assets, noise paths, and query-string URLs
      const isAsset = /\.(pdf|jpg|jpeg|png|gif|svg|css|js|xml|json|woff|woff2|ttf|ico|map)$/i.test(pathname);
      const isNoise = [
        "/tag/", "/author/", "/page/", "/rss", "/feed",
        "/webmentions/", "/assets/", "/public/", "/ghost/",
        "/sitemap", "/amp/", "/subscribe", "/signin", "/signup",
      ].some((seg) => pathname.startsWith(seg) || pathname.includes(seg));
      const hasQuery = parsedUrl.search.length > 0;

      if (
        getOrigin(normalized) === allowedOrigin &&
        !visited.has(normalized) &&
        !isAsset &&
        !isNoise &&
        !hasQuery
      ) {
        links.push(normalized);
      }
    }

    return [...new Set(links)];
  } catch {
    return [];
  }
}

// ─── Raw HTTP fetch for link discovery ───────────────────────────────────────
function fetchRaw(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        },
        timeout: 8000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchRaw(res.headers.location).then(resolve).catch(reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function getOrigin(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign");
    let href = u.href;
    if (href.endsWith("/") && u.pathname !== "/") href = href.slice(0, -1);
    return href;
  } catch {
    return url;
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < retries) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
