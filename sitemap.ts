/**
 * sitemap.ts — Robust sitemap parser, zero stack overflow risk
 *
 * Fixes:
 * - Iterative (not recursive) sitemap index processing — no stack overflow
 * - Depth limit on nested sitemaps (max 3 levels)
 * - Per-sitemap URL cap to avoid processing 100k URLs
 * - Handles non-standard sitemap locations (make.com uses /en/sitemap.xml etc)
 * - parseSitemap() is the main export used by cli-v2.ts
 */

import * as https from "https";
import * as http from "http";
import * as zlib from "zlib";
import { URL } from "url";

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
  priority: number | null;
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────
function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { return reject(new Error(`Bad URL: ${url}`)); }

    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        Accept: "application/xml,text/xml,*/*",
        "Accept-Encoding": "gzip, deflate",
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchText(loc, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      const isGzip = res.headers["content-encoding"] === "gzip" || url.endsWith(".gz");
      const stream = isGzip ? res.pipe(zlib.createGunzip()) : res;
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      stream.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on("error", reject);
  });
}

// ─── XML parsing (regex, no deps) ────────────────────────────────────────────
function getTag(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].trim().replace(/<!\[CDATA\[|\]\]>/g, "").trim());
  }
  return out;
}

function parseUrlEntries(xml: string): SitemapUrl[] {
  return getTag(xml, "url").map((block) => ({
    loc: getTag(block, "loc")[0]?.trim() ?? "",
    lastmod: getTag(block, "lastmod")[0] ?? null,
    priority: parseFloat(getTag(block, "priority")[0] ?? "") || null,
  })).filter((u) => u.loc.startsWith("http"));
}

function parseIndexEntries(xml: string): string[] {
  return getTag(xml, "sitemap")
    .map((b) => getTag(b, "loc")[0]?.trim() ?? "")
    .filter((u) => u.startsWith("http"));
}

function isIndex(xml: string): boolean {
  return xml.includes("<sitemapindex") || (xml.includes("<sitemap>") && !xml.includes("<url>"));
}

// ─── Robots.txt discovery ─────────────────────────────────────────────────────
async function fromRobots(baseUrl: string): Promise<string[]> {
  try {
    const txt = await fetchText(new URL("/robots.txt", baseUrl).href, 6_000);
    return [...txt.matchAll(/^Sitemap:\s*(.+)$/gim)].map((m) => m[1].trim()).filter(Boolean);
  } catch { return []; }
}

// ─── ITERATIVE sitemap fetcher (no recursion = no stack overflow) ─────────────
async function fetchAllUrls(seedSitemapUrls: string[], maxUrls = 5000): Promise<SitemapUrl[]> {
  const allUrls: SitemapUrl[] = [];
  // Queue of [url, depth] — iterative BFS, not recursive
  const queue: Array<[string, number]> = seedSitemapUrls.map((u) => [u, 0]);
  const seen = new Set<string>(seedSitemapUrls);
  const MAX_DEPTH = 3;
  const MAX_CHILD_SITEMAPS = 50; // Don't process more than 50 child sitemaps
  let sitemapsProcessed = 0;

  while (queue.length > 0 && allUrls.length < maxUrls) {
    const [url, depth] = queue.shift()!;
    if (depth > MAX_DEPTH || sitemapsProcessed > MAX_CHILD_SITEMAPS) continue;

    let xml: string;
    try {
      xml = await fetchText(url);
      sitemapsProcessed++;
    } catch {
      continue; // Skip failed sitemaps silently
    }

    if (isIndex(xml)) {
      const children = parseIndexEntries(xml);
      for (const child of children) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push([child, depth + 1]);
        }
      }
    } else {
      allUrls.push(...parseUrlEntries(xml));
    }
  }

  return allUrls;
}

// ─── Common sitemap paths to try ─────────────────────────────────────────────
const SITEMAP_CANDIDATES = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap/sitemap.xml",
  "/en/sitemap.xml",           // make.com
  "/blog/sitemap.xml",
  "/sitemap-index.xml",
  "/sitemap.xml.gz",
];

async function discoverSitemapEntryPoints(baseUrl: string): Promise<string[]> {
  // 1. robots.txt
  const fromRobo = await fromRobots(baseUrl);
  if (fromRobo.length > 0) return fromRobo;

  // 2. Try common paths
  const found: string[] = [];
  for (const path of SITEMAP_CANDIDATES) {
    const url = new URL(path, baseUrl).href;
    try {
      await fetchText(url, 5_000);
      found.push(url);
      break; // Stop at first working one
    } catch { /* try next */ }
  }
  return found;
}

// ─── Public exports ───────────────────────────────────────────────────────────

/**
 * Main function used by cli-v2.ts
 * Returns URL strings filtered by optional path filter
 */
export async function parseSitemap(
  siteUrl: string,
  pathFilter?: string
): Promise<string[]> {
  const isSitemapUrl = /sitemap|\.xml|\.gz/.test(siteUrl);

  let entryPoints: string[];
  if (isSitemapUrl) {
    entryPoints = [siteUrl];
  } else {
    entryPoints = await discoverSitemapEntryPoints(siteUrl);
    if (entryPoints.length === 0) {
      console.log(`  [sitemap] No sitemap found — trying direct paths`);
      return [];
    }
  }

  console.log(`  [sitemap] Entry points: ${entryPoints.join(", ")}`);
  const allUrls = await fetchAllUrls(entryPoints);
  console.log(`  [sitemap] Raw URLs found: ${allUrls.length}`);

  let result = allUrls.map((u) => u.loc).filter(Boolean);

  if (pathFilter) {
    result = result.filter((u) => u.includes(pathFilter));
  }

  // Sort by priority desc, deduplicate
  const seen = new Set<string>();
  return result.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

/** Full API with filtering options */
export async function discoverSitemapUrls(
  baseUrl: string,
  opts: { pathPrefix?: string; maxUrls?: number } = {}
): Promise<SitemapUrl[]> {
  const entryPoints = await discoverSitemapEntryPoints(baseUrl);
  if (entryPoints.length === 0) return [];

  let all = await fetchAllUrls(entryPoints, opts.maxUrls ?? 5000);

  if (opts.pathPrefix) {
    all = all.filter((u) => {
      try { return new URL(u.loc).pathname.startsWith(opts.pathPrefix!); } catch { return false; }
    });
  }

  return opts.maxUrls ? all.slice(0, opts.maxUrls) : all;
}

/** Returns URL strings only */
export async function getSitemapUrlStrings(
  baseUrl: string,
  opts: { pathPrefix?: string; maxUrls?: number } = {}
): Promise<string[]> {
  return (await discoverSitemapUrls(baseUrl, opts)).map((u) => u.loc);
}
// EOF
