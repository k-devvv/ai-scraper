/**
 * sitemap.ts
 * Sitemap discovery and URL extraction engine.
 *
 * Features:
 *  - Auto-discovers sitemap from robots.txt
 *  - Handles sitemap index files (nested sitemaps)
 *  - Handles compressed .xml.gz sitemaps
 *  - Filters URLs by pattern, path prefix, or lastmod date
 *  - Falls back to /sitemap.xml and /sitemap_index.xml
 */

import * as https from "https";
import * as http from "http";
import * as zlib from "zlib";
import { URL } from "url";

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: number | null;
}

export interface SitemapOptions {
  /** Only include URLs matching this path prefix e.g. "/blog/" */
  pathPrefix?: string;
  /** Only include URLs matching this regex pattern */
  pattern?: RegExp;
  /** Only include URLs modified after this date (ISO string) */
  modifiedAfter?: string;
  /** Max URLs to return (0 = no limit) */
  maxUrls?: number;
  /** Timeout in ms for each HTTP request */
  timeoutMs?: number;
}

// ─── HTTP fetch (no browser needed for XML) ───────────────────────────────────

function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SitemapBot/1.0)",
          Accept: "application/xml,text/xml,*/*",
        },
      },
      (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchText(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        const chunks: Buffer[] = [];
        const isGzip =
          res.headers["content-encoding"] === "gzip" || url.endsWith(".gz");

        const stream = isGzip ? res.pipe(zlib.createGunzip()) : res;

        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        stream.on("error", reject);
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });

    req.on("error", reject);
  });
}

// ─── XML Parsers (regex-based, no external deps) ─────────────────────────────

function extractTagValues(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    values.push(match[1].trim().replace(/<!\[CDATA\[|\]\]>/g, ""));
  }
  return values;
}

function parseSitemapUrls(xml: string): SitemapUrl[] {
  const urlBlocks = extractTagValues(xml, "url");
  return urlBlocks.map((block) => {
    const loc = extractTagValues(block, "loc")[0] ?? "";
    const lastmod = extractTagValues(block, "lastmod")[0] ?? null;
    const changefreq = extractTagValues(block, "changefreq")[0] ?? null;
    const priorityStr = extractTagValues(block, "priority")[0];
    const priority = priorityStr ? parseFloat(priorityStr) : null;
    return { loc, lastmod, changefreq, priority };
  });
}

function parseSitemapIndexUrls(xml: string): string[] {
  const sitemapBlocks = extractTagValues(xml, "sitemap");
  return sitemapBlocks.map((block) => extractTagValues(block, "loc")[0] ?? "").filter(Boolean);
}

function isSitemapIndex(xml: string): boolean {
  return xml.includes("<sitemapindex") || xml.includes("<sitemap>");
}

// ─── Robots.txt Discovery ─────────────────────────────────────────────────────

async function getSitemapUrlsFromRobots(baseUrl: string): Promise<string[]> {
  try {
    const robotsUrl = new URL("/robots.txt", baseUrl).href;
    const text = await fetchText(robotsUrl);
    const matches = [...text.matchAll(/^Sitemap:\s*(.+)$/gim)];
    return matches.map((m) => m[1].trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Main Sitemap Fetcher ─────────────────────────────────────────────────────

async function fetchSitemapXml(sitemapUrl: string, timeoutMs: number): Promise<SitemapUrl[]> {
  let xml: string;
  try {
    xml = await fetchText(sitemapUrl, timeoutMs);
  } catch (err) {
    console.warn(`[sitemap] Failed to fetch ${sitemapUrl}: ${err}`);
    return [];
  }

  if (isSitemapIndex(xml)) {
    // Recursively fetch all child sitemaps
    const childUrls = parseSitemapIndexUrls(xml);
    console.log(`[sitemap] Index found with ${childUrls.length} child sitemaps`);
    const results: SitemapUrl[] = [];
    for (const childUrl of childUrls) {
      const childResults = await fetchSitemapXml(childUrl, timeoutMs);
      results.push(...childResults);
    }
    return results;
  }

  return parseSitemapUrls(xml);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Discover and return all URLs from a website's sitemap.
 *
 * @param baseUrl - The website root URL e.g. "https://example.com"
 * @param opts    - Filtering and limit options
 */
export async function discoverSitemapUrls(
  baseUrl: string,
  opts: SitemapOptions = {}
): Promise<SitemapUrl[]> {
  const {
    pathPrefix,
    pattern,
    modifiedAfter,
    maxUrls = 0,
    timeoutMs = 15_000,
  } = opts;

  // 1. Try robots.txt first
  let sitemapUrls = await getSitemapUrlsFromRobots(baseUrl);

  // 2. Fall back to common sitemap paths
  if (sitemapUrls.length === 0) {
    const candidates = [
      new URL("/sitemap.xml", baseUrl).href,
      new URL("/sitemap_index.xml", baseUrl).href,
      new URL("/sitemap/sitemap.xml", baseUrl).href,
    ];

    for (const candidate of candidates) {
      try {
        await fetchText(candidate, 5_000);
        sitemapUrls = [candidate];
        break;
      } catch {
        // try next
      }
    }
  }

  if (sitemapUrls.length === 0) {
    console.warn(`[sitemap] No sitemap found for ${baseUrl}`);
    return [];
  }

  console.log(`[sitemap] Found ${sitemapUrls.length} sitemap(s) to crawl`);

  // 3. Fetch all sitemap URLs
  let allUrls: SitemapUrl[] = [];
  for (const sitemapUrl of sitemapUrls) {
    const urls = await fetchSitemapXml(sitemapUrl, timeoutMs);
    allUrls.push(...urls);
  }

  console.log(`[sitemap] Total URLs discovered: ${allUrls.length}`);

  // 4. Apply filters
  if (pathPrefix) {
    allUrls = allUrls.filter((u) => {
      try {
        return new URL(u.loc).pathname.startsWith(pathPrefix);
      } catch {
        return false;
      }
    });
  }

  if (pattern) {
    allUrls = allUrls.filter((u) => pattern.test(u.loc));
  }

  if (modifiedAfter) {
    const cutoff = new Date(modifiedAfter).getTime();
    allUrls = allUrls.filter((u) => {
      if (!u.lastmod) return true; // keep if no date info
      return new Date(u.lastmod).getTime() >= cutoff;
    });
  }

  // 5. Sort by priority (highest first), then by lastmod (newest first)
  allUrls.sort((a, b) => {
    const priorityDiff = (b.priority ?? 0.5) - (a.priority ?? 0.5);
    if (priorityDiff !== 0) return priorityDiff;
    if (a.lastmod && b.lastmod) {
      return new Date(b.lastmod).getTime() - new Date(a.lastmod).getTime();
    }
    return 0;
  });

  // 6. Apply limit
  if (maxUrls > 0) {
    allUrls = allUrls.slice(0, maxUrls);
  }

  return allUrls;
}

/**
 * Quick helper — just get the URL strings from a sitemap.
 */
export async function getSitemapUrlStrings(
  baseUrl: string,
  opts: SitemapOptions = {}
): Promise<string[]> {
  const urls = await discoverSitemapUrls(baseUrl, opts);
  return urls.map((u) => u.loc);
}
