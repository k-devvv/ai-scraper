/**
 * extractor-cheerio.ts
 * CSS-selector based extraction for known site schemas.
 * Zero AI cost, ~1ms per page, site-specific accuracy.
 *
 * Phase 1 fixes:
 * - CheerioAPI not exported in this cheerio version — use ReturnType<typeof load>
 * - SchemaRule doesn't exist — the correct export is FieldRule from selectors.ts
 * - Cheerio.Element callbacks typed explicitly to avoid implicit any
 */

import * as cheerio from "cheerio";
import { SCHEMA_RULES } from "./selectors";
import type { FieldRule } from "./selectors";   // ← FieldRule, not SchemaRule

// Use the return type of cheerio.load() — works across all cheerio versions
type CheerioRoot = ReturnType<typeof cheerio.load>;

export interface CheerioResult {
  data: Record<string, unknown>;
  confidence: number;
  found: string[];
  missing: string[];
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function extractWithCheerio(html: string, schemaName: string): CheerioResult {
  const rules = SCHEMA_RULES[schemaName];

  if (!rules) {
    return { data: {}, confidence: 0, found: [], missing: [] };
  }

  const $: CheerioRoot = cheerio.load(html);

  const data: Record<string, unknown> = {};

  applyCssRules($, rules, data);
  promoteFromJsonLd($, schemaName, data);
  applyMetaFallbacks($, schemaName, data);
  applyHeuristics($, schemaName, data);

  if (schemaName === "pricing") {
    parsePricingTiers($, data);
  }

  const fields     = Object.keys(rules);
  const found      = fields.filter((f) => data[f] !== undefined && data[f] !== "" && data[f] !== null);
  const missing    = fields.filter((f) => !found.includes(f));
  const confidence = fields.length > 0 ? Math.round((found.length / fields.length) * 100) : 0;

  return { data, confidence, found, missing };
}

// ─── CSS rule application ─────────────────────────────────────────────────────

function applyCssRules(
  $: CheerioRoot,
  rules: Record<string, FieldRule>,
  data: Record<string, unknown>
): void {
  for (const [field, rule] of Object.entries(rules)) {
    if (data[field] !== undefined) continue;

    let value: unknown;

    if (rule.type === "text") {
      for (const selector of rule.selectors) {
        const el = $(selector).first();
        if (el.length > 0) {
          const text = el.text().trim();
          if (text) { value = text; break; }
        }
      }
    }

    if (rule.type === "attr") {
      for (const selector of rule.selectors) {
        const el = $(selector).first();
        if (el.length > 0) {
          const attr = el.attr(rule.attr ?? "content");
          if (attr) { value = attr.trim(); break; }
        }
      }
    }

    if (rule.type === "list") {
      for (const selector of rule.selectors) {
        const items: string[] = [];
        $(selector).each((_i: number, el: cheerio.Element) => {
          const text = $(el).text().trim();
          if (text) items.push(text);
        });
        if (items.length > 0) {
          value = rule.limit ? items.slice(0, rule.limit) : items;
          break;
        }
      }
    }

    if (rule.type === "table") {
      for (const selector of rule.selectors) {
        const items: string[] = [];
        $(selector).each((_i: number, el: cheerio.Element) => {
          const text = $(el).text().trim();
          if (text) items.push(text);
        });
        if (items.length > 0) {
          // table rules don't have limit in the FieldRule union, cast to access if present
          const limit = (rule as unknown as { limit?: number }).limit;
          value = limit ? items.slice(0, limit) : items;
          break;
        }
      }
    }

    if (rule.type === "bool") {
      for (const selector of rule.selectors) {
        const el = $(selector).first();
        if (el.length > 0) {
          const text = el.text().toLowerCase().trim();
          const trueVals = rule.trueValues ?? ["in stock", "available", "add to cart"];
          value = trueVals.some((v) => text.includes(v));
          break;
        }
      }
    }

    if (rule.type === "number") {
      for (const selector of rule.selectors) {
        const el = $(selector).first();
        if (el.length > 0) {
          const text = el.text().trim();
          const num  = parseFloat(text.replace(/[^0-9.]/g, ""));
          if (!isNaN(num)) { value = num; break; }
        }
      }
    }

    if (rule.type === "rating") {
      for (const selector of rule.selectors) {
        const el = $(selector).first();
        if (el.length > 0) {
          const text = el.text().trim();
          const num  = parseFloat(text.replace(/[^0-9.]/g, ""));
          if (!isNaN(num)) { value = num; break; }
          // class-based rating: "star-rating three" → 3
          const cls = el.attr("class") ?? "";
          const wordMatch = cls.match(/\b(one|two|three|four|five)\b/i);
          if (wordMatch) {
            const map: Record<string, number> = { one:1, two:2, three:3, four:4, five:5 };
            value = map[wordMatch[1].toLowerCase()];
            break;
          }
        }
      }
    }

    if (value !== undefined) data[field] = value;
  }
}

// ─── JSON-LD extraction ───────────────────────────────────────────────────────

function promoteFromJsonLd(
  $: CheerioRoot,
  schemaName: string,
  data: Record<string, unknown>
): void {
  $('script[type="application/ld+json"]').each((_i: number, el: cheerio.Element) => {
    try {
      const raw    = $(el).html() ?? "";
      const parsed = JSON.parse(raw);
      const obj    = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!obj || typeof obj !== "object") return;

      if (schemaName === "product" || (obj as any)["@type"] === "Product") {
        if (!data.product_name && (obj as any).name)        data.product_name  = String((obj as any).name);
        if (!data.description  && (obj as any).description) data.description   = String((obj as any).description);
        if (!data.rating       && (obj as any).aggregateRating?.ratingValue)
          data.rating = parseFloat(String((obj as any).aggregateRating.ratingValue));
        if (!data.price        && (obj as any).offers?.price)
          data.price = String((obj as any).offers.price);
        if (!data.sku          && (obj as any).sku) data.sku = String((obj as any).sku);
      }

      if (schemaName === "article" || (obj as any)["@type"] === "Article" || (obj as any)["@type"] === "BlogPosting") {
        if (!data.title          && (obj as any).headline)      data.title          = String((obj as any).headline);
        if (!data.author         && (obj as any).author?.name)  data.author         = String((obj as any).author.name);
        if (!data.published_date && (obj as any).datePublished) data.published_date = String((obj as any).datePublished);
        if (!data.summary        && (obj as any).description)   data.summary        = String((obj as any).description);
      }

      if (schemaName === "job" || (obj as any)["@type"] === "JobPosting") {
        if (!data.title       && (obj as any).title)                          data.title   = String((obj as any).title);
        if (!data.company     && (obj as any).hiringOrganization?.name)       data.company = String((obj as any).hiringOrganization.name);
        if (!data.location    && (obj as any).jobLocation?.address?.addressLocality)
          data.location = String((obj as any).jobLocation.address.addressLocality);
        if (!data.description && (obj as any).description)                    data.description = String((obj as any).description);
      }
    } catch { /* ignore malformed JSON-LD */ }
  });
}

// ─── Meta tag fallbacks ───────────────────────────────────────────────────────

function applyMetaFallbacks(
  $: CheerioRoot,
  schemaName: string,
  data: Record<string, unknown>
): void {
  const ogTitle       = $('meta[property="og:title"]').attr("content");
  const ogDescription = $('meta[property="og:description"]').attr("content");
  const metaDesc      = $('meta[name="description"]').attr("content");

  const titleField = schemaName === "product" ? "product_name"
    : ["job", "article", "blog"].includes(schemaName) ? "title"
    : null;

  if (titleField && !data[titleField] && ogTitle) data[titleField] = ogTitle.trim();

  const descField = schemaName === "product" ? "description"
    : ["article", "blog"].includes(schemaName) ? "summary"
    : null;

  if (descField && !data[descField]) {
    const val = (ogDescription ?? metaDesc ?? "").trim();
    if (val) data[descField] = val;
  }
}

// ─── Heuristic extraction ─────────────────────────────────────────────────────

function applyHeuristics(
  $: CheerioRoot,
  schemaName: string,
  data: Record<string, unknown>
): void {
  const titleField = schemaName === "product" ? "product_name"
    : ["article", "blog", "job", "review"].includes(schemaName) ? "title"
    : null;

  if (titleField && !data[titleField]) {
    const h1 = $("h1").first().text().trim();
    if (h1) data[titleField] = h1;
  }

  if (schemaName === "product" && !data.price) {
    for (const sel of [".price", "#price", '[class*="price"]', ".product-price"]) {
      const text = $(sel).first().text().trim();
      if (text && /[\d.,]+/.test(text)) { data.price = text; break; }
    }
  }

  if ((schemaName === "article" || schemaName === "blog") && !data.author) {
    for (const sel of ['[rel="author"]', ".author", ".byline", '[itemprop="author"]']) {
      const text = $(sel).first().text().trim();
      if (text && text.length < 100) { data.author = text; break; }
    }
  }
}

// ─── Pricing tier parser ──────────────────────────────────────────────────────

function parsePricingTiers(
  $: CheerioRoot,
  data: Record<string, unknown>
): void {
  const tiers: Array<Record<string, unknown>> = [];

  for (const sel of [".pricing-card", ".pricing-plan", ".price-card", ".plan", '[class*="pricing"]']) {
    const cards = $(sel);
    if (cards.length === 0) continue;

    cards.each((_i: number, el: cheerio.Element) => {
      const card    = $(el);
      const name    = card.find("h2, h3, .plan-name, .plan-title").first().text().trim();
      const price   = card.find(".price, .amount, [class*='price']").first().text().trim();
      const cta     = card.find("a, button").first().text().trim();
      const bullets = card.find("li").map((_j: number, li: cheerio.Element) => $(li).text().trim()).get();

      if (name || price) tiers.push({ name, price, cta, features: bullets });
    });

    if (tiers.length > 0) break;
  }

  if (tiers.length > 0) {
    data.plans      = tiers;
    data.plan_count = tiers.length;
  }
}
