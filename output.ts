/**
 * output.ts
 * Multi-format output writer — JSON, CSV, Markdown, JSONL.
 *
 * Features:
 *  - Auto-creates output directory
 *  - Timestamped filenames to avoid overwrites
 *  - JSON: pretty-printed with metadata header
 *  - JSONL: one JSON object per line (ideal for LLM training data)
 *  - CSV: flat + handles nested arrays/objects gracefully
 *  - Markdown: human-readable report with tables
 */

import * as fs from "fs";
import * as path from "path";
import type { CrawlResult, CrawlPageResult } from "./crawler";

export type OutputFormat = "json" | "csv" | "markdown" | "jsonl";

export interface OutputOptions {
  /** Directory to write output files. Default: ./output */
  dir?: string;
  /** Base filename without extension. Default: auto-timestamped */
  filename?: string;
  /** Which formats to write */
  formats?: OutputFormat[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function flattenObject(
  obj: unknown,
  prefix = "",
  maxDepth = 2,
  depth = 0
): Record<string, string> {
  const result: Record<string, string> = {};

  if (depth > maxDepth || obj === null || obj === undefined) {
    result[prefix] = String(obj ?? "");
    return result;
  }

  if (Array.isArray(obj)) {
    result[prefix] = obj.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(" | ");
    return result;
  }

  if (typeof obj === "object") {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      const nested = flattenObject(val, newKey, maxDepth, depth + 1);
      Object.assign(result, nested);
    }
    return result;
  }

  result[prefix] = String(obj);
  return result;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";

  // Flatten all rows and collect all unique column names
  const flatRows = rows.map((r) => flattenObject(r));
  const allColumns = [...new Set(flatRows.flatMap((r) => Object.keys(r)))];

  const escape = (val: unknown): string => {
    const str = val === null || val === undefined ? "" : String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = allColumns.map(escape).join(",");
  const dataRows = flatRows.map((row) =>
    allColumns.map((col) => escape(row[col] ?? "")).join(",")
  );

  return [header, ...dataRows].join("\n");
}

// ─── Single-URL output ────────────────────────────────────────────────────────

export interface SingleResult {
  url: string;
  schema: string;
  model: string;
  scrapedAt: string;
  data: unknown;
  inputTokens: number;
  outputTokens: number;
}

export function writeSingleResult(
  result: SingleResult,
  opts: OutputOptions = {}
): Record<OutputFormat, string> {
  const {
    dir = "./output",
    filename = `scrape_${timestamp()}`,
    formats = ["json"],
  } = opts;

  ensureDir(dir);
  const written: Record<string, string> = {};

  for (const fmt of formats) {
    const filepath = path.join(dir, `${filename}.${fmt === "markdown" ? "md" : fmt}`);

    if (fmt === "json") {
      fs.writeFileSync(filepath, JSON.stringify(result, null, 2), "utf-8");
    }

    if (fmt === "jsonl") {
      fs.writeFileSync(filepath, JSON.stringify(result) + "\n", "utf-8");
    }

    if (fmt === "csv") {
      const row =
        result.data && typeof result.data === "object" && !Array.isArray(result.data)
          ? [result.data as Record<string, unknown>]
          : Array.isArray(result.data)
          ? (result.data as Record<string, unknown>[])
          : [{ data: JSON.stringify(result.data) }];
      fs.writeFileSync(filepath, toCsv(row), "utf-8");
    }

    if (fmt === "markdown") {
      const md = [
        `# Scrape Result`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| URL | ${result.url} |`,
        `| Schema | ${result.schema} |`,
        `| Model | ${result.model} |`,
        `| Scraped At | ${result.scrapedAt} |`,
        `| Tokens | ${result.inputTokens} in / ${result.outputTokens} out |`,
        ``,
        `## Extracted Data`,
        ``,
        "```json",
        JSON.stringify(result.data, null, 2),
        "```",
      ].join("\n");
      fs.writeFileSync(filepath, md, "utf-8");
    }

    written[fmt] = filepath;
    console.log(`  [output] ${fmt.toUpperCase()} → ${filepath}`);
  }

  return written as Record<OutputFormat, string>;
}

// ─── Batch output ─────────────────────────────────────────────────────────────

export interface BatchResult {
  schema: string;
  model: string;
  scrapedAt: string;
  totalUrls: number;
  successCount: number;
  errorCount: number;
  results: Array<{
    url: string;
    status: "success" | "error";
    data?: unknown;
    error?: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }>;
}

export function writeBatchResults(
  batch: BatchResult,
  opts: OutputOptions = {}
): Record<OutputFormat, string> {
  const {
    dir = "./output",
    filename = `batch_${timestamp()}`,
    formats = ["json", "csv"],
  } = opts;

  ensureDir(dir);
  const written: Record<string, string> = {};

  const successRows = batch.results
    .filter((r) => r.status === "success" && r.data)
    .map((r) => ({ url: r.url, ...(r.data as Record<string, unknown>) }));

  for (const fmt of formats) {
    const filepath = path.join(dir, `${filename}.${fmt === "markdown" ? "md" : fmt}`);

    if (fmt === "json") {
      fs.writeFileSync(filepath, JSON.stringify(batch, null, 2), "utf-8");
    }

    if (fmt === "jsonl") {
      const lines = batch.results.map((r) => JSON.stringify(r)).join("\n");
      fs.writeFileSync(filepath, lines, "utf-8");
    }

    if (fmt === "csv") {
      fs.writeFileSync(filepath, toCsv(successRows), "utf-8");
    }

    if (fmt === "markdown") {
      const tableRows = batch.results
        .map((r) => {
          const status = r.status === "success" ? "✓" : "✗";
          const info = r.status === "error" ? r.error ?? "Unknown error" : `${r.inputTokens}t`;
          return `| ${status} | ${r.url} | ${r.durationMs}ms | ${info} |`;
        })
        .join("\n");

      const md = [
        `# Batch Scrape Report`,
        ``,
        `**Schema:** ${batch.schema}  `,
        `**Model:** ${batch.model}  `,
        `**Date:** ${batch.scrapedAt}  `,
        `**Results:** ${batch.successCount}/${batch.totalUrls} succeeded`,
        ``,
        `## Pages`,
        ``,
        `| Status | URL | Duration | Info |`,
        `|--------|-----|----------|------|`,
        tableRows,
        ``,
        `## Extracted Data`,
        ``,
        ...batch.results
          .filter((r) => r.status === "success")
          .map(
            (r) =>
              `### ${r.url}\n\n\`\`\`json\n${JSON.stringify(r.data, null, 2)}\n\`\`\`\n`
          ),
      ].join("\n");
      fs.writeFileSync(filepath, md, "utf-8");
    }

    written[fmt] = filepath;
    console.log(`  [output] ${fmt.toUpperCase()} → ${filepath}`);
  }

  return written as Record<OutputFormat, string>;
}

// ─── Crawl output ─────────────────────────────────────────────────────────────

export function writeCrawlResults(
  crawl: CrawlResult,
  opts: OutputOptions = {}
): Record<OutputFormat, string> {
  const {
    dir = "./output",
    filename = `crawl_${timestamp()}`,
    formats = ["json", "csv", "markdown"],
  } = opts;

  ensureDir(dir);
  const written: Record<string, string> = {};

  const successPages = crawl.pages.filter((p) => p.status === "success");

  for (const fmt of formats) {
    const filepath = path.join(dir, `${filename}.${fmt === "markdown" ? "md" : fmt}`);

    if (fmt === "json") {
      fs.writeFileSync(filepath, JSON.stringify(crawl, null, 2), "utf-8");
    }

    if (fmt === "jsonl") {
      // One line per page's extracted data
      const lines = successPages
        .filter((p) => p.data)
        .map((p) => JSON.stringify({ url: p.url, depth: p.depth, ...p.data }))
        .join("\n");
      fs.writeFileSync(filepath, lines, "utf-8");
    }

    if (fmt === "csv") {
      const rows = successPages
        .filter((p) => p.data)
        .map((p) => ({
          url: p.url,
          depth: p.depth,
          ...(p.data as Record<string, unknown>),
        }));
      fs.writeFileSync(filepath, toCsv(rows), "utf-8");
    }

    if (fmt === "markdown") {
      const pageSection = (p: CrawlPageResult): string => {
        const lines = [`### ${p.url}`, ``];
        lines.push(`**Depth:** ${p.depth} | **Duration:** ${p.durationMs}ms`);
        if (p.inputTokens) lines.push(`**Tokens:** ${p.inputTokens}in / ${p.outputTokens}out`);
        lines.push(``);
        if (p.data) {
          lines.push("```json");
          lines.push(JSON.stringify(p.data, null, 2));
          lines.push("```");
        } else if (p.error) {
          lines.push(`**Error:** ${p.error}`);
        }
        lines.push(``);
        return lines.join("\n");
      };

      const md = [
        `# Crawl Report`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| Seed URL | ${crawl.seedUrl} |`,
        `| Total Pages | ${crawl.totalPages} |`,
        `| Success | ${crawl.successCount} |`,
        `| Errors | ${crawl.errorCount} |`,
        `| Duration | ${(crawl.durationMs / 1000).toFixed(1)}s |`,
        `| Total Tokens | ${crawl.totalInputTokens}in / ${crawl.totalOutputTokens}out |`,
        ``,
        `## Pages`,
        ``,
        ...crawl.pages.map(pageSection),
      ].join("\n");

      fs.writeFileSync(filepath, md, "utf-8");
    }

    written[fmt] = filepath;
    console.log(`  [output] ${fmt.toUpperCase()} → ${filepath}`);
  }

  return written as Record<OutputFormat, string>;
}

// ─── Markdown-only output ─────────────────────────────────────────────────────

export function writeMarkdownDump(
  pages: Array<{ url: string; markdown: string }>,
  opts: OutputOptions = {}
): string {
  const {
    dir = "./output",
    filename = `markdown_${timestamp()}`,
  } = opts;

  ensureDir(dir);

  const content = pages
    .map((p) => [`# ${p.url}`, ``, p.markdown, ``].join("\n"))
    .join("\n---\n\n");

  const filepath = path.join(dir, `${filename}.md`);
  fs.writeFileSync(filepath, content, "utf-8");
  console.log(`  [output] MARKDOWN → ${filepath}`);
  return filepath;
}
