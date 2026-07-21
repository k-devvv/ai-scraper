/**
 * pipeline.ts
 * Universal scrape pipeline: fetch → clean → extract → result
 *
 * Modes:
 *   cheerio — CSS selectors only, ~1ms, zero AI cost (site-specific accuracy)
 *   hybrid  — cheerio first, AI fallback if confidence < threshold (RECOMMENDED)
 *   ai      — Ollama only, universal, works on any site
 */

import { fetchPage } from "./fetcher";
import { htmlToMarkdown } from "./cleaner";
import { extractWithCheerio } from "./extractor-cheerio";
import { extractWithOllama } from "./extractor";
import type { OllamaSchema } from "./extractor";
import { SCHEMA_RULES } from "./selectors";
import { SCHEMA_MAP } from "./schemas";

export type PipelineMode = "cheerio" | "hybrid" | "ai";

export interface PipelineOptions {
  mode?: PipelineMode;
  schema: string;
  model?: string;
  hybridThreshold?: number;
  verbose?: boolean;
  proxy?: string;
  fetchMode?: "auto" | "fast" | "stealth" | "intercept";
  /** Pre-built schema from a natural-language request; overrides `schema` and forces AI mode. */
  nlSchema?: OllamaSchema;
}

export interface PipelineResult {
  url: string;
  data: Record<string, unknown>;
  confidence: number;
  found: string[];
  missing: string[];
  method: "cheerio" | "ai" | "hybrid";
  inputTokens: number;
  outputTokens: number;
  fetchMs: number;
  extractMs: number;
  totalMs: number;
  truncated: boolean;
}

// ─── Type-safe SCHEMA_MAP lookup ──────────────────────────────────────────────
// SCHEMA_MAP is typed as a const object — we cast via Record<string, …> to allow
// dynamic key access without "No index signature" TS7053 errors.
type AnySchemaMap = Record<string, (typeof SCHEMA_MAP)[keyof typeof SCHEMA_MAP] | undefined>;
const SCHEMA_LOOKUP = SCHEMA_MAP as AnySchemaMap;

export async function runPipeline(
  url: string,
  opts: PipelineOptions
): Promise<PipelineResult> {
  const start     = Date.now();
  // A natural-language schema has no Cheerio rule set, so force AI.
  const mode      = opts.nlSchema ? "ai" : (opts.mode ?? "hybrid");
  const model     = opts.model ?? "qwen2.5:7b";
  const threshold = opts.hybridThreshold ?? 70;
  const verbose   = opts.verbose ?? false;

  const hasCheerioSchema = !!SCHEMA_RULES[opts.schema];
  const hasAiSchema      = !!SCHEMA_LOOKUP[opts.schema];   // ← fixed: TS7053

  // ── Stage 1: Fetch ──────────────────────────────────────────────────────────

  if (verbose) console.log(`[1/3] Fetching: ${url}`);

  const fetchStart = Date.now();
  const fetched    = await fetchPage(url, { mode: opts.fetchMode ?? "auto", proxy: opts.proxy });
  const fetchMs    = Date.now() - fetchStart;

  if (verbose) {
    // fetcher.ts now always sets fetchMode on FetchResult — TS2339 is fixed there
    const resolvedFetchMode = fetched.fetchMode ?? opts.fetchMode ?? "fast";
    console.log(
      ` → ${fetched.html.length.toLocaleString()} chars | HTTP ${fetched.statusCode} | ${fetchMs}ms | mode: ${resolvedFetchMode}`
    );
  }

  // ── Stage 2: Extract ────────────────────────────────────────────────────────

  const extractStart = Date.now();

  // Cheerio-only mode
  if (mode === "cheerio") {
    if (!hasCheerioSchema) {
      throw new Error(`Schema "${opts.schema}" not in selectors.ts. Available: ${Object.keys(SCHEMA_RULES).join(", ")}`);
    }
    if (verbose) console.log(`[2/3] Extracting with Cheerio (schema: ${opts.schema})`);

    const cr        = extractWithCheerio(fetched.html, opts.schema);
    const extractMs = Date.now() - extractStart;

    if (verbose) {
      console.log(` → Confidence: ${cr.confidence}% | Found: [${cr.found.join(", ")}]`);
      console.log(` → Done in ${extractMs}ms`);
    }

    return {
      url, data: cr.data, confidence: cr.confidence,
      found: cr.found, missing: cr.missing,
      method: "cheerio", inputTokens: 0, outputTokens: 0,
      fetchMs, extractMs, totalMs: Date.now() - start, truncated: false,
    };
  }

  // AI-only mode
  if (mode === "ai") {
    if (verbose) console.log(`[2/3] Extracting with Ollama (schema: ${opts.schema})`);
    return runAiExtraction(url, fetched.html, opts, fetchMs, start, verbose);
  }

  // Hybrid mode: cheerio first, AI fallback
  if (mode === "hybrid") {
    let cheerioConf = 0;
    let cheerioData: Record<string, unknown> = {};

    if (hasCheerioSchema) {
      if (verbose) console.log(`[2/3] Extracting with Cheerio (schema: ${opts.schema})`);
      const cr        = extractWithCheerio(fetched.html, opts.schema);
      const extractMs = Date.now() - extractStart;
      cheerioConf     = cr.confidence;
      cheerioData     = cr.data;

      if (verbose) {
        console.log(` → Confidence: ${cr.confidence}% | Found: [${cr.found.join(", ")}]`);
        console.log(` → Done in ${extractMs}ms`);
      }

      if (cr.confidence >= threshold) {
        return {
          url, data: cr.data, confidence: cr.confidence,
          found: cr.found, missing: cr.missing,
          method: "cheerio", inputTokens: 0, outputTokens: 0,
          fetchMs, extractMs, totalMs: Date.now() - start, truncated: false,
        };
      }

      if (verbose) {
        console.log(` ⚠ Confidence ${cr.confidence}% < ${threshold}% — running AI fallback`);
      }
    } else {
      if (verbose) console.log(`[2/3] No Cheerio schema for "${opts.schema}" — going straight to AI`);
    }

    const aiResult = await runAiExtraction(url, fetched.html, opts, fetchMs, start, verbose);
    const merged   = { ...aiResult.data, ...cheerioData };

    const schemaFields = Object.keys(SCHEMA_RULES[opts.schema] ?? {});
    const found    = schemaFields.length > 0
      ? schemaFields.filter((f) => merged[f] !== undefined)
      : Object.keys(merged);
    const missing  = schemaFields.filter((f) => merged[f] === undefined);
    const confidence = schemaFields.length > 0
      ? Math.round((found.length / schemaFields.length) * 100)
      : Math.min(100, cheerioConf + 20);

    return { ...aiResult, data: merged, confidence, found, missing, method: "hybrid" };
  }

  throw new Error(`Unknown mode: ${mode}`);
}

// ─── AI extraction (Ollama) ───────────────────────────────────────────────────

async function runAiExtraction(
  url: string,
  html: string,
  opts: PipelineOptions,
  fetchMs: number,
  startTime: number,
  verbose: boolean
): Promise<PipelineResult> {
  // Natural-language schema wins over any preset lookup.
  let schema = opts.nlSchema ?? SCHEMA_LOOKUP[opts.schema];
  if (!schema) {
    schema = buildDynamicSchema(opts.schema);
  }

  const cleaned      = htmlToMarkdown(html);
  const extractStart = Date.now();

  if (verbose) {
    console.log(` → Markdown: ${cleaned.charCount.toLocaleString()} chars (~${cleaned.estimatedTokens} tokens)`);
  }

  const aiResult  = await extractWithOllama(cleaned.markdown, schema, opts.model ?? "qwen2.5:7b");
  const extractMs = Date.now() - extractStart;

  if (verbose) {
    console.log(` → AI tokens: ${aiResult.inputTokens} in / ${aiResult.outputTokens} out | truncated: ${aiResult.truncated}`);
  }

  const schemaFields = Object.keys(SCHEMA_RULES[opts.schema] ?? {});
  const dataKeys     = Object.keys(aiResult.data);
  const found        = schemaFields.length > 0
    ? schemaFields.filter((k) => aiResult.data[k] !== undefined)
    : dataKeys;
  const missing      = schemaFields.filter((k) => aiResult.data[k] === undefined);
  const confidence   = schemaFields.length > 0
    ? Math.round((found.length / schemaFields.length) * 100)
    : dataKeys.length > 0 ? 85 : 0;

  return {
    url,
    data: aiResult.data,
    confidence,
    found,
    missing,
    method: "ai",
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
    fetchMs,
    extractMs,
    totalMs: Date.now() - startTime,
    truncated: aiResult.truncated,
  };
}

// ─── Dynamic schema builder for unknown schema names ─────────────────────────

function buildDynamicSchema(schemaName: string) {
  const schemaPrompts: Record<string, { description: string; fields: Record<string, string> }> = {
    saas_ideas: {
      description: "Extract AI/SaaS business ideas, automation use cases, and tools from this page.",
      fields: {
        page_title: "Main title of the page or article",
        ideas: "Array of business ideas, use cases, or automation opportunities mentioned",
        summary: "Brief summary of the page content",
        categories: "Array of topic categories or tags",
        author: "Author name if present",
        published_date: "Publication date if present",
        tools_mentioned: "Array of tools, platforms, or technologies mentioned",
      },
    },
    product: {
      description: "Extract product information from this e-commerce page.",
      fields: {
        product_name: "Name of the product",
        price: "Price as a number",
        currency: "Currency code e.g. USD, GBP, INR",
        in_stock: "Boolean whether product is in stock",
        description: "Product description",
        features: "Array of product features",
        rating: "Star rating as a number",
        sku: "Product SKU or ID",
      },
    },
    article: {
      description: "Extract article information from this blog or news page.",
      fields: {
        title: "Article headline",
        author: "Author name",
        published_date: "Publication date",
        summary: "Article summary or excerpt",
        key_points: "Array of main points or section headings",
        tags: "Array of topic tags",
      },
    },
    job: {
      description: "Extract job listing details from this page.",
      fields: {
        title: "Job title",
        company: "Company name",
        location: "Job location",
        salary: "Salary or compensation",
        job_type: "Full-time, part-time, contract, etc.",
        skills: "Array of required skills",
        description: "Job description summary",
      },
    },
  };

  const template = schemaPrompts[schemaName] ?? {
    description: `Extract key information related to "${schemaName.replace(/_/g, " ")}" from this page.`,
    fields: {
      title: "Main title or heading",
      summary: "Brief summary of the content",
      key_points: "Array of main points, items, or headings",
      metadata: "Any relevant dates, authors, or categories",
    },
  };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const arrayFields = ["ideas", "key_points", "features", "tags", "skills", "tools_mentioned", "categories"];
  const numberFields = ["price", "rating"];
  const booleanFields = ["in_stock"];

  for (const [field, desc] of Object.entries(template.fields)) {
    if (arrayFields.includes(field)) {
      properties[field] = { type: "array", items: { type: "string" }, description: desc };
    } else if (numberFields.includes(field)) {
      properties[field] = { type: "number", description: desc };
    } else if (booleanFields.includes(field)) {
      properties[field] = { type: "boolean", description: desc };
    } else {
      properties[field] = { type: "string", description: desc };
    }
    required.push(field);
  }

  return {
    name: `extract_${schemaName}`,
    description: template.description,
    input_schema: {
      type: "object" as const,
      properties,
      required,
    },
  };
}

