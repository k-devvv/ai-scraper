/**
 * pipeline.ts — Universal scrape pipeline
 *
 * Modes:
 *   cheerio  — CSS selectors only, instant, zero AI cost
 *   hybrid   — Cheerio first, AI only if confidence < threshold
 *   ai       — Ollama only, universal fallback
 *
 * EXPERT DESIGN DECISIONS:
 * - Default threshold: 40% (not 70%). Ghost/n8n blogs max at 57% with cheerio
 *   because author/tags are JS-rendered. 57% > 40% = cheerio wins, no AI call.
 * - Per-schema threshold overrides built in. saas_ideas gets 40%, product gets 60%.
 * - AI fallback merges with cheerio result (union of both extractions).
 */

import { fetchPage } from "./fetcher";
import { htmlToMarkdown } from "./cleaner";
import { extractWithCheerio } from "./extractor-cheerio";
import { extractWithOllama } from "./extractor";
import { SCHEMA_RULES } from "./selectors";
import { SCHEMA_MAP } from "./schemas";

export type PipelineMode = "cheerio" | "hybrid" | "ai";

// Per-schema smart thresholds based on what cheerio can realistically achieve
// These are the MAXIMUM confidence cheerio will ever hit on these site types
const SCHEMA_THRESHOLDS: Record<string, number> = {
  saas_ideas: 40,   // Ghost CMS: author/tags are JS-only. Cheerio max ≈ 57%. Accept it.
  article:    55,   // Most blogs: author/date/tags often JS-rendered
  blog:       55,
  product:    60,   // WooCommerce/Shopify: most fields static. Push for more.
  job:        50,
  company:    45,
  pricing:    55,
  review:     50,
};

export interface PipelineOptions {
  mode?: PipelineMode;
  schema: string;
  model?: string;
  hybridThreshold?: number; // overrides per-schema default if passed
  verbose?: boolean;
  fetchMode?: "auto" | "fast" | "stealth" | "intercept";
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

export async function runPipeline(
  url: string,
  opts: PipelineOptions
): Promise<PipelineResult> {
  const start = Date.now();
  const mode = opts.mode ?? "hybrid";
  const model = opts.model ?? "qwen2.5:7b";
  const verbose = opts.verbose ?? false;

  // Use caller-provided threshold, or schema-specific smart default
  const threshold = opts.hybridThreshold ?? SCHEMA_THRESHOLDS[opts.schema] ?? 50;

  const hasCheerioSchema = !!SCHEMA_RULES[opts.schema];
  const hasAiSchema = !!SCHEMA_MAP[opts.schema];

  // ── Stage 1: Fetch ──────────────────────────────────────────────────────────
  if (verbose) console.log(`[1/3] Fetching: ${url}`);
  const fetchStart = Date.now();
  const fetched = await fetchPage(url, { mode: opts.fetchMode ?? "auto" });
  const fetchMs = Date.now() - fetchStart;

  if (verbose) {
    const fetchMode = fetched.fetchMode ?? opts.fetchMode ?? "fast";
    console.log(
      `      → ${fetched.html.length.toLocaleString()} chars | HTTP ${fetched.statusCode} | ${fetchMs}ms | mode: ${fetchMode}`
    );
  }

  // ── Stage 2: Cheerio-only ───────────────────────────────────────────────────
  if (mode === "cheerio") {
    if (!hasCheerioSchema) throw new Error(`No cheerio schema for "${opts.schema}"`);
    if (verbose) console.log(`[2/3] Extracting with Cheerio (schema: ${opts.schema})`);
    const cr = extractWithCheerio(fetched.html, opts.schema);
    const extractMs = Date.now() - fetchStart - fetchMs;
    if (verbose) {
      console.log(`      → Confidence: ${cr.confidence}% | Found: [${cr.found.join(", ")}]`);
      console.log(`      → Done in ${extractMs}ms`);
    }
    return cheerioResult(url, cr, fetchMs, extractMs, start);
  }

  // ── Stage 3: AI-only ────────────────────────────────────────────────────────
  if (mode === "ai") {
    if (verbose) console.log(`[2/3] Extracting with Ollama (schema: ${opts.schema})`);
    return runAi(url, fetched.html, opts, fetchMs, start, verbose);
  }

  // ── Stage 4: Hybrid — Cheerio first, AI only if needed ─────────────────────
  if (mode === "hybrid") {
    const extractStart = Date.now();

    if (!hasCheerioSchema) {
      if (verbose) console.log(`[2/3] No cheerio schema → going to AI`);
      return runAi(url, fetched.html, opts, fetchMs, start, verbose);
    }

    if (verbose) console.log(`[2/3] Extracting with Cheerio (schema: ${opts.schema})`);
    const cr = extractWithCheerio(fetched.html, opts.schema);
    const extractMs = Date.now() - extractStart;

    if (verbose) {
      console.log(`      → Confidence: ${cr.confidence}% | Found: [${cr.found.join(", ")}]`);
      console.log(`      → Done in ${extractMs}ms`);
    }

    // Cheerio is good enough — return immediately, no AI
    if (cr.confidence >= threshold) {
      if (verbose) console.log(`      ✓ ${cr.confidence}% ≥ threshold(${threshold}%) — skipping AI`);
      return cheerioResult(url, cr, fetchMs, extractMs, start);
    }

    // Cheerio is weak — call AI to fill gaps
    if (verbose) {
      console.log(`      ⚠ ${cr.confidence}% < threshold(${threshold}%) — calling AI to fill gaps`);
    }

    // Only call AI if we have a schema for it
    if (!hasAiSchema) {
      if (verbose) console.log(`      (no AI schema for "${opts.schema}" — using cheerio result)`);
      return cheerioResult(url, cr, fetchMs, extractMs, start);
    }

    const aiResult = await runAi(url, fetched.html, opts, fetchMs, start, verbose);

    // Merge: cheerio exact matches take priority, AI fills missing fields
    const merged = { ...aiResult.data, ...cr.data };
    const schemaFields = Object.keys(SCHEMA_RULES[opts.schema] ?? {});
    const found = schemaFields.filter((f) => merged[f] !== undefined);
    const missing = schemaFields.filter((f) => merged[f] === undefined);
    const confidence = schemaFields.length > 0
      ? Math.round((found.length / schemaFields.length) * 100)
      : Math.min(100, cr.confidence + 20);

    return { ...aiResult, data: merged, confidence, found, missing, method: "hybrid" };
  }

  throw new Error(`Unknown mode: ${mode}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function cheerioResult(
  url: string,
  cr: { data: Record<string, unknown>; confidence: number; found: string[]; missing: string[] },
  fetchMs: number,
  extractMs: number,
  start: number
): PipelineResult {
  return {
    url, data: cr.data, confidence: cr.confidence,
    found: cr.found, missing: cr.missing,
    method: "cheerio", inputTokens: 0, outputTokens: 0,
    fetchMs, extractMs, totalMs: Date.now() - start, truncated: false,
  };
}

async function runAi(
  url: string,
  html: string,
  opts: PipelineOptions,
  fetchMs: number,
  startTime: number,
  verbose: boolean
): Promise<PipelineResult> {
  const schema = SCHEMA_MAP[opts.schema] ?? buildDynamicSchema(opts.schema);
  const cleaned = htmlToMarkdown(html);
  const extractStart = Date.now();

  if (verbose) {
    console.log(`      → Markdown: ${cleaned.charCount.toLocaleString()} chars (~${cleaned.estimatedTokens} tokens)`);
  }

  const ai = await extractWithOllama(cleaned.markdown, schema, opts.model ?? "qwen2.5:7b");
  const extractMs = Date.now() - extractStart;

  if (verbose) {
    console.log(`      → AI: ${ai.inputTokens}in / ${ai.outputTokens}out tokens | truncated: ${ai.truncated}`);
  }

  const schemaFields = Object.keys(SCHEMA_RULES[opts.schema] ?? {});
  const dataKeys = Object.keys(ai.data);
  const found = schemaFields.length > 0 ? schemaFields.filter((k) => ai.data[k] !== undefined) : dataKeys;
  const missing = schemaFields.filter((k) => ai.data[k] === undefined);
  const confidence = schemaFields.length > 0
    ? Math.round((found.length / schemaFields.length) * 100)
    : dataKeys.length > 0 ? 85 : 0;

  return {
    url, data: ai.data, confidence, found, missing,
    method: "ai",
    inputTokens: ai.inputTokens, outputTokens: ai.outputTokens,
    fetchMs, extractMs, totalMs: Date.now() - startTime, truncated: ai.truncated,
  };
}

function buildDynamicSchema(schemaName: string) {
  const templates: Record<string, { description: string; fields: Record<string, string> }> = {
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
        title: "Job title", company: "Company name", location: "Job location",
        salary: "Salary or compensation", job_type: "Employment type",
        skills: "Array of required skills", description: "Job description",
      },
    },
  };

  const template = templates[schemaName] ?? {
    description: `Extract key information about "${schemaName.replace(/_/g, " ")}" from this page.`,
    fields: {
      title: "Main title", summary: "Brief summary",
      key_points: "Array of main points", metadata: "Dates, authors, categories",
    },
  };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const arrayFields = new Set(["ideas","key_points","features","tags","skills","tools_mentioned","categories","images"]);
  const numberFields = new Set(["price","rating","review_count"]);
  const boolFields = new Set(["in_stock"]);

  for (const [field, desc] of Object.entries(template.fields)) {
    if (arrayFields.has(field)) properties[field] = { type: "array", items: { type: "string" }, description: desc };
    else if (numberFields.has(field)) properties[field] = { type: "number", description: desc };
    else if (boolFields.has(field)) properties[field] = { type: "boolean", description: desc };
    else properties[field] = { type: "string", description: desc };
    required.push(field);
  }

  return {
    name: `extract_${schemaName}`,
    description: template.description,
    input_schema: { type: "object" as const, properties, required },
  };
}
