/**
 * mcp/server.ts — Model Context Protocol server for ai-scraper.
 *
 * Exposes the local scraping pipeline as tools an AI agent (Claude Desktop,
 * Cursor, any MCP client) can call over stdio. This is the SAME engine the
 * REST API uses — the MCP layer is a thin, synchronous adapter over
 * src/pipeline, src/fetcher, and src/cleaner. No job queue here: agents expect
 * a result in the same call, so tools await and return inline.
 *
 * Tools (v1):
 *   - scrape            single URL → typed JSON via local AI extraction
 *   - extract_markdown  single URL → clean Markdown (no AI, fast)
 *   - list_schemas      names of built-in extraction schemas
 *
 * Safety: every URL passes through the same SSRF validation the HTTP API uses
 * (validateUrl) before any fetch — agents call with arbitrary URLs, so this is
 * not optional.
 *
 * Run:  npm run start:mcp     (or: npx tsx mcp/server.ts)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runPipeline } from "../src/pipeline";
import { fetchPage } from "../src/fetcher";
import { htmlToMarkdown } from "../src/cleaner";
import { SCHEMA_MAP } from "../src/schemas";
import { validateUrl } from "../api/middleware/security";

const server = new McpServer({ name: "ai-scraper", version: "3.2.0" });

const SCHEMA_NAMES = Object.keys(SCHEMA_MAP);
const FETCH_MODES = ["auto", "fast", "stealth", "intercept"] as const;
const EXTRACT_MODES = ["cheerio", "hybrid", "ai"] as const;

/** Reject unsafe URLs before any network call. Returns an MCP error result. */
function ssrfGuard(url: string): { content: { type: "text"; text: string }[]; isError: true } | null {
  const check = validateUrl(url);
  if (!check.valid) {
    return {
      content: [{ type: "text", text: `URL rejected: ${check.reason ?? "failed validation"}` }],
      isError: true,
    };
  }
  return null;
}

// ─── Tool: scrape ─────────────────────────────────────────────────────────────

server.registerTool(
  "scrape",
  {
    title: "Scrape URL to typed JSON",
    description:
      "Fetch a single URL and extract structured data as typed JSON using a local LLM (Ollama). " +
      "Pick a schema from list_schemas (e.g. 'product', 'article', 'pricing'). " +
      "Runs fully locally with zero API cost. Requires Ollama running with the target model pulled.",
    inputSchema: {
      url: z.string().url().describe("The URL to scrape"),
      schema: z
        .enum(SCHEMA_NAMES as [string, ...string[]])
        .describe("Extraction schema — call list_schemas to see all options"),
      mode: z
        .enum(EXTRACT_MODES)
        .optional()
        .describe("cheerio (fast rules), ai (LLM only), or hybrid (default: rules then LLM fallback)"),
      fetchMode: z
        .enum(FETCH_MODES)
        .optional()
        .describe("auto (default), fast (HTTP only), stealth (headless browser), intercept (capture XHR JSON)"),
      model: z.string().optional().describe("Ollama model name (default: qwen2.5:7b)"),
    },
    outputSchema: {
      url: z.string(),
      data: z.record(z.unknown()),
      confidence: z.number(),
      method: z.string(),
      found: z.array(z.string()),
      missing: z.array(z.string()),
      totalMs: z.number(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  async ({ url, schema, mode, fetchMode, model }) => {
    const blocked = ssrfGuard(url);
    if (blocked) return blocked;

    try {
      const r = await runPipeline(url, {
        schema,
        mode: mode ?? "hybrid",
        fetchMode: fetchMode ?? "auto",
        ...(model ? { model } : {}),
      });
      const structured = {
        url: r.url,
        data: r.data,
        confidence: r.confidence,
        method: r.method,
        found: r.found,
        missing: r.missing,
        totalMs: r.totalMs,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text:
              `Scrape failed: ${msg}\n\n` +
              `Common causes: Ollama not running (start it and pull the model), ` +
              `the site blocked the request (try fetchMode: "stealth"), or the model name is wrong.`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: extract_markdown ───────────────────────────────────────────────────

server.registerTool(
  "extract_markdown",
  {
    title: "URL to clean Markdown",
    description:
      "Fetch a URL and return clean, token-optimised Markdown of the main content — no AI, no Ollama needed. " +
      "Fast. Ideal when an agent just needs to read a page rather than extract structured fields.",
    inputSchema: {
      url: z.string().url().describe("The URL to convert to Markdown"),
      fetchMode: z
        .enum(FETCH_MODES)
        .optional()
        .describe("auto (default), fast (HTTP only), stealth (headless browser for JS-heavy sites)"),
    },
    outputSchema: {
      url: z.string(),
      markdown: z.string(),
      charCount: z.number(),
      estimatedTokens: z.number(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  async ({ url, fetchMode }) => {
    const blocked = ssrfGuard(url);
    if (blocked) return blocked;

    try {
      const fetched = await fetchPage(url, { mode: fetchMode ?? "auto" });
      const clean = htmlToMarkdown(fetched.html);
      const structured = {
        url: fetched.finalUrl,
        markdown: clean.markdown,
        charCount: clean.charCount,
        estimatedTokens: clean.estimatedTokens,
      };
      return {
        content: [{ type: "text", text: clean.markdown }],
        structuredContent: structured,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `Markdown extraction failed: ${msg}\n\nIf the site is JS-heavy, retry with fetchMode: "stealth".` },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: list_schemas ───────────────────────────────────────────────────────

server.registerTool(
  "list_schemas",
  {
    title: "List extraction schemas",
    description:
      "List the built-in extraction schema names available to the scrape tool. " +
      "Call this first to discover valid values for the scrape tool's `schema` argument.",
    inputSchema: {},
    outputSchema: { schemas: z.array(z.string()) },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  async () => {
    const structured = { schemas: SCHEMA_NAMES };
    return {
      content: [{ type: "text", text: `Available schemas:\n${SCHEMA_NAMES.map((s) => `  - ${s}`).join("\n")}` }],
      structuredContent: structured,
    };
  }
);

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP protocol channel and must stay clean.
  console.error("[ai-scraper mcp] server ready on stdio — tools: scrape, extract_markdown, list_schemas");
}

main().catch((err) => {
  console.error("[ai-scraper mcp] fatal:", err);
  process.exit(1);
});
