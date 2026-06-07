/**
 * crawler.ts
 * Deep recursive web crawler — Firecrawl/xCrawl-level link following.
 *
 * Features:
 *  - BFS (breadth-first) link discovery and crawling
 *  - Stays within the same domain by default
 *  - Configurable depth limit, page limit, and URL patterns
 *  - Respects crawl delay between requests
 *  - Deduplication via visited URL set
 *  - Extracts all internal links from each page using regex (no extra deps)
 *  - Per-page AI extraction with any schema
 *  - Real-time progress reporting
 *  - Concurrent page processing with a configurable pool
 */

import { fetchPage } from "./browser";
import { htmlToMarkdown } from "./cleaner";
import { extractWithOllama, type ExtractResult, type OllamaSchema } from "./extractor";
import { SCHEMA_MAP, type SchemaKey } from "./schemas";
import { URL } from "url";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CrawlOptions {
  /** Schema to use for AI extraction on each page */
  schema: SchemaKey | OllamaSchema;
  /** Max depth to follow links (1 = only the seed URL) */
  maxDepth?: number;
  /** Max total pages to crawl */
  maxPages?: number;
  /** Milliseconds to wait between page fetches */
  delayMs?: number;
  /** How many pages to process in parallel */
  concurrency?: number;
  /** Only follow links matching this regex pattern */
  includePattern?: RegExp;
  /** Skip links matching this regex pattern */
  excludePattern?: RegExp;
  /** Stay within the same domain as the seed URL */
  sameDomainOnly?: boolean;
  /** Ollama model to use for extraction */
  model?: string;
  /** Skip AI extraction and only collect raw markdown */
  markdownOnly?: boolean;
  /** Callback fired after each page is processed */
  onPage?: (result: CrawlPageResult) => void | Promise<void>;
}

export interface CrawlPageResult {
  url: string;
  depth: number;
  status: "success" | "error";
  markdown?: string;
  data?: unknown;
  error?: string;
  linksFound: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CrawlResult {
  seedUrl: string;
  totalPages: number;
  successCount: number;
  errorCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  pages: CrawlPageResult[];
}

// ─── Link Extraction (regex-based, no jsdom needed) ──────────────────────────

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const hrefRegex = /href=["']([^"'#?]+(?:\?[^"']*)?)/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("javascript:") || raw.startsWith("mailto:")) continue;

    try {
      const absolute = new URL(raw, baseUrl).href;
      // Only keep http/https URLs
      if (absolute.startsWith("http://") || absolute.startsWith("https://")) {
        // Strip fragment
        links.push(absolute.split("#")[0]);
      }
    } catch {
      // Invalid URL — skip
    }
  }

  // Deduplicate
  return [...new Set(links)];
}

function shouldInclude(
  url: string,
  opts: CrawlOptions,
  seedDomain: string
): boolean {
  // Same domain check
  if (opts.sameDomainOnly !== false) {
    try {
      const urlDomain = new URL(url).hostname;
      if (urlDomain !== seedDomain) return false;
    } catch {
      return false;
    }
  }

  // Include pattern
  if (opts.includePattern && !opts.includePattern.test(url)) return false;

  // Exclude pattern
  if (opts.excludePattern && opts.excludePattern.test(url)) return false;

  // Skip common non-content URLs
  const skipExtensions = /\.(css|js|json|xml|pdf|zip|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|mp4|mp3)$/i;
  if (skipExtensions.test(url)) return false;

  return true;
}

// ─── Core Crawler ─────────────────────────────────────────────────────────────

export async function crawl(
  seedUrl: string,
  opts: CrawlOptions
): Promise<CrawlResult> {
  const {
    maxDepth = 3,
    maxPages = 50,
    delayMs = 500,
    concurrency = 2,
    model = "qwen2.5:7b",
    markdownOnly = false,
    onPage,
  } = opts;

  const resolvedSchema: OllamaSchema =
    typeof opts.schema === "string" ? SCHEMA_MAP[opts.schema] : opts.schema;

  const seedDomain = new URL(seedUrl).hostname;
  const visited = new Set<string>();
  const results: CrawlPageResult[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const startTime = Date.now();

  // BFS queue: [url, depth]
  const queue: Array<[string, number]> = [[seedUrl, 0]];
  visited.add(seedUrl);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  CRAWLER START`);
  console.log(`  Seed:        ${seedUrl}`);
  console.log(`  Max depth:   ${maxDepth}`);
  console.log(`  Max pages:   ${maxPages}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Schema:      ${typeof opts.schema === "string" ? opts.schema : opts.schema.name}`);
  console.log(`${"─".repeat(60)}\n`);

  async function processPage(url: string, depth: number): Promise<CrawlPageResult> {
    const pageStart = Date.now();
    console.log(`  [${results.length + 1}/${maxPages}] depth=${depth} ${url}`);

    try {
      // 1. Fetch
      const { html, finalUrl } = await fetchPage(url);

      // 2. Extract links before cleaning (links are in raw HTML)
      let linksFound = 0;
      if (depth < maxDepth) {
        const links = extractLinks(html, finalUrl);
        for (const link of links) {
          if (
            visited.size + queue.length < maxPages * 2 && // prevent queue explosion
            !visited.has(link) &&
            shouldInclude(link, opts, seedDomain)
          ) {
            visited.add(link);
            queue.push([link, depth + 1]);
            linksFound++;
          }
        }
      }

      // 3. Clean HTML → Markdown
      const { markdown } = htmlToMarkdown(html);

      if (markdownOnly) {
        const result: CrawlPageResult = {
          url: finalUrl,
          depth,
          status: "success",
          markdown,
          linksFound,
          durationMs: Date.now() - pageStart,
        };
        return result;
      }

      // 4. AI extraction
      const extracted: ExtractResult = await extractWithOllama(markdown, resolvedSchema, model);

      const result: CrawlPageResult = {
        url: finalUrl,
        depth,
        status: "success",
        markdown,
        data: extracted.data,
        linksFound,
        durationMs: Date.now() - pageStart,
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
      };

      totalInputTokens += extracted.inputTokens;
      totalOutputTokens += extracted.outputTokens;

      console.log(
        `      ✓ ${extracted.inputTokens}in/${extracted.outputTokens}out tokens | ${linksFound} new links | ${Date.now() - pageStart}ms`
      );

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`      ✗ Error: ${msg}`);
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

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // BFS loop with concurrency pool
  while (queue.length > 0 && results.length < maxPages) {
    // Pull a batch up to concurrency limit
    const batch: Array<[string, number]> = [];
    while (batch.length < concurrency && queue.length > 0 && results.length + batch.length < maxPages) {
      const item = queue.shift();
      if (item) batch.push(item);
    }

    if (batch.length === 0) break;

    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map(([url, depth]) => processPage(url, depth))
    );

    for (const result of batchResults) {
      results.push(result);
      if (onPage) await onPage(result);
    }

    // Delay between batches
    if (delayMs > 0 && queue.length > 0) {
      await sleep(delayMs);
    }
  }

  const successCount = results.filter((r) => r.status === "success").length;
  const errorCount = results.filter((r) => r.status === "error").length;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  CRAWL COMPLETE`);
  console.log(`  Pages:  ${results.length} (${successCount} ok, ${errorCount} errors)`);
  console.log(`  Tokens: ${totalInputTokens}in / ${totalOutputTokens}out`);
  console.log(`  Time:   ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`${"─".repeat(60)}\n`);

  return {
    seedUrl,
    totalPages: results.length,
    successCount,
    errorCount,
    totalInputTokens,
    totalOutputTokens,
    durationMs: Date.now() - startTime,
    pages: results,
  };
}
