/**
 * crawler-v2.ts — BFS deep crawler with smart link filtering
 *
 * Key features:
 * - Seed-path scoping: if seed URL has a path (e.g. /blog), only follows links under that path
 * - Blocks nav/asset/utility URLs automatically
 * - Concurrency pool with polite delays
 * - Retry with exponential backoff
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

export async function crawl(seedUrl: string, opts: CrawlOptions): Promise<CrawlSummary> {
  const maxDepth    = opts.maxDepth ?? 2;
  const maxPages    = opts.maxPages ?? 20;
  const concurrency = opts.concurrency ?? 3;
  const delayMs     = opts.delayMs ?? 200;
  const retries     = opts.retries ?? 1;

  const seedParsed  = new URL(normalizeUrl(seedUrl));
  const seedOrigin  = seedParsed.origin;
  // Seed path scope: only crawl URLs under this path prefix
  // e.g. https://ycombinator.com/blog → only /blog/* links
  const seedPath    = seedParsed.pathname === "/" ? "" : seedParsed.pathname.replace(/\/$/, "");

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

    await Promise.all(batch.map(async ([url, depth]) => {
      pageCount++;
      console.log(`\n  [${pageCount}/${maxPages}] depth=${depth} ${url}`);
      const pageStart = Date.now();

      try {
        const result = await withRetry(() => runPipeline(url, { ...opts, verbose: true }), retries);

        // Discover links from this page
        const newLinks = await discoverLinks(url, seedOrigin, seedPath, visited, maxDepth, depth);
        let added = 0;
        for (const link of newLinks) {
          if (!visited.has(link)) {
            visited.add(link);
            queue.push([link, depth + 1]);
            added++;
          }
        }
        console.log(`      ✓ conf=${result.confidence}% | ${result.fetchMs}ms fetch + ${result.extractMs}ms extract | ${added} new links`);

        results.push({ url, depth, status: "success", result, durationMs: Date.now() - pageStart });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`      ✗ ${msg}`);
        results.push({ url, depth, status: "error", error: msg, durationMs: Date.now() - pageStart });
      }

      if (delayMs > 0) await sleep(delayMs);
    }));
  }

  const successes = results.filter((r) => r.status === "success");
  const confs = successes.map((r) => r.result?.confidence ?? 0).filter((c) => c > 0);
  const avgConfidence = confs.length > 0 ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : 0;

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
  seedPath: string,        // e.g. "/blog" — only follow links under this
  visited: Set<string>,
  maxDepth: number,
  currentDepth: number
): Promise<string[]> {
  if (currentDepth >= maxDepth) return [];

  try {
    const html = await fetchRaw(pageUrl);
    const links: string[] = [];
    const re = /href=["']([^"'#][^"']*?)["']/gi;
    let m: RegExpExecArray | null;

    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      let resolved: string;

      if (href.startsWith("http")) resolved = href;
      else if (href.startsWith("/")) resolved = allowedOrigin + href;
      else continue;

      let normalized: string;
      try { normalized = normalizeUrl(resolved); } catch { continue; }

      let u: URL;
      try { u = new URL(normalized); } catch { continue; }

      const pathname = u.pathname;

      // Must be same origin
      if (u.origin !== allowedOrigin) continue;

      // Must be under the seed path (if seed had a non-root path)
      if (seedPath && !pathname.startsWith(seedPath)) continue;

      // Skip already visited
      if (visited.has(normalized)) continue;

      // Skip assets
      if (/\.(pdf|jpg|jpeg|png|gif|svg|css|js|xml|json|woff|woff2|ttf|ico|map|zip|gz)$/i.test(pathname)) continue;

      // Skip utility paths
      const utilityPaths = [
        "/tag/", "/author/", "/page/", "/rss", "/feed", "/feeds",
        "/webmentions/", "/assets/", "/public/", "/ghost/",
        "/sitemap", "/amp/", "/subscribe", "/signin", "/signup", "/login",
        "/logout", "/account", "/cart", "/checkout", "/search",
        "/cdn-cgi/", "/_next/", "/static/", "/api/",
      ];
      if (utilityPaths.some((p) => pathname.startsWith(p) || pathname.includes(p))) continue;

      // Skip query strings (tracking params etc)
      if (u.search.length > 0) continue;

      links.push(normalized);
    }

    return [...new Set(links)];
  } catch {
    return [];
  }
}

// ─── Raw HTTP fetch (for link discovery only) ─────────────────────────────────
function fetchRaw(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchRaw(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","ref","source"].forEach((p) => u.searchParams.delete(p));
    let href = u.href;
    if (href.endsWith("/") && u.pathname !== "/") href = href.slice(0, -1);
    return href;
  } catch { return url; }
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
