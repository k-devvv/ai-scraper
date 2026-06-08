/**
 * extractor-cheerio.ts
 * Cheerio-based extraction engine — zero AI, ~1ms per page.
 *
 * Extraction order:
 *  1. CSS selectors (from selectors.ts registry)
 *  2. JSON-LD structured data promotion
 *  3. OpenGraph / meta tag fallbacks
 *  4. Smart heuristics per schema
 */

import * as cheerio from "cheerio";
import { SCHEMA_RULES, WORD_RATINGS } from "./selectors";
import type { SchemaRules } from "./selectors";

export interface CheerioResult {
  data: Record<string, unknown>;
  confidence: number;
  found: string[];
  missing: string[];
  method: "cheerio";
  durationMs: number;
}

export function extractWithCheerio(html: string, schemaName: string): CheerioResult {
  const start = Date.now();
  const rules = SCHEMA_RULES[schemaName];
  if (!rules) throw new Error(`Unknown schema: "${schemaName}"`);

  const $ = cheerio.load(html);
  const data: Record<string, unknown> = {};

  applyCssRules($, rules, data);
  promoteFromJsonLd($, schemaName, data);
  applyMetaFallbacks($, schemaName, data);
  applyHeuristics($, schemaName, data);

  // Clean empty values
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (val === "" || val === null || val === undefined || (Array.isArray(val) && val.length === 0)) {
      delete data[key];
    }
  }

  const schemaFields = Object.keys(rules);
  const found = schemaFields.filter((f) => data[f] !== undefined);
  const missing = schemaFields.filter((f) => data[f] === undefined);
  const confidence = Math.round((found.length / schemaFields.length) * 100);

  return { data, confidence, found, missing, method: "cheerio", durationMs: Date.now() - start };
}

// ─── Stage 1: CSS rules ───────────────────────────────────────────────────────
function applyCssRules($: cheerio.CheerioAPI, rules: SchemaRules, data: Record<string, unknown>): void {
  for (const [field, rule] of Object.entries(rules)) {
    for (const sel of rule.selectors) {
      const el = $(sel).first();
      if (!el.length) continue;
      let value: unknown;

      switch (rule.type) {
        case "text": {
          const t = el.text().trim();
          if (t) value = t;
          break;
        }
        case "attr": {
          const a = el.attr(rule.attr)?.trim();
          if (a) value = a;
          break;
        }
        case "number": {
          const raw = el.attr("content") || el.text();
          const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
          if (!isNaN(n)) value = n;
          break;
        }
        case "bool": {
          const text = el.text().toLowerCase().trim();
          const cls = el.attr("class")?.toLowerCase() ?? "";
          const trueVals = rule.trueValues ?? ["in stock", "available"];
          if (cls.includes("instock") || trueVals.some((v) => text.includes(v))) value = true;
          else if (text.includes("out of stock") || text.includes("unavailable")) value = false;
          else if (el.length) value = true;
          break;
        }
        case "rating": {
          const numStr = el.attr("content") || el.text();
          const n = parseFloat(numStr.replace(/[^0-9.]/g, ""));
          if (!isNaN(n) && n > 0) { value = n; break; }
          const cls = el.attr("class") ?? "";
          for (const [word, rating] of Object.entries(WORD_RATINGS)) {
            if (cls.includes(word)) { value = rating; break; }
          }
          break;
        }
        case "list": {
          const items: string[] = [];
          $(sel).each((_, elem) => {
            const t = $(elem).text().trim().replace(/\s+/g, " ");
            if (t && t.length >= 8 && t.length <= 300 && !items.includes(t)) items.push(t);
          });
          if (items.length > 0) value = rule.limit ? items.slice(0, rule.limit) : items;
          break;
        }
        case "table": {
          const tableData: Record<string, string> = {};
          const tableEl = $(sel);
          const rows = tableEl.is("tr") ? tableEl : tableEl.find("tr");
          rows.each((_, row) => {
            const cells = $(row).find("td, th");
            if (cells.length >= 2) {
              const k = $(cells[0]).text().trim().replace(/\s+/g, " ");
              const v = $(cells[1]).text().trim().replace(/\s+/g, " ");
              if (k && v) tableData[k] = v;
            }
          });
          if (Object.keys(tableData).length === 0) {
            const items: string[] = [];
            $(sel).each((_, elem) => {
              const t = $(elem).text().trim();
              if (t) items.push(t);
            });
            if (items.length > 0) { value = rule.limit ? items.slice(0, rule.limit) : items; break; }
          }
          if (Object.keys(tableData).length > 0) value = tableData;
          break;
        }
      }

      if (value !== undefined) { data[field] = value; break; }
    }
  }
}

// ─── Stage 2: JSON-LD promotion ───────────────────────────────────────────────
function promoteFromJsonLd($: cheerio.CheerioAPI, schemaName: string, data: Record<string, unknown>): void {
  const blocks: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html()?.trim() ?? "{}");
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed as Record<string, unknown>);
    } catch { /* malformed JSON-LD */ }
  });

  for (const block of blocks) {
    const type = (block["@type"] as string)?.toLowerCase() ?? "";

    if (schemaName === "product" && type.includes("product")) {
      if (!data.price) {
        const offers = block["offers"] as Record<string, unknown> | undefined;
        if (offers) {
          const p = parseFloat(String(offers["price"] ?? ""));
          if (!isNaN(p)) data.price = p;
          if (!data.currency) { const c = offers["priceCurrency"] as string; if (c) data.currency = c; }
          if (!data.in_stock) {
            const avail = String(offers["availability"] ?? "").toLowerCase();
            if (avail.includes("instock")) data.in_stock = true;
            else if (avail.includes("outofstock")) data.in_stock = false;
          }
        }
      }
      if (!data.sku && block["sku"]) data.sku = block["sku"];
      if (!data.brand) { const b = block["brand"] as Record<string, unknown>; if (b?.["name"]) data.brand = b["name"]; }
      if (!data.description && block["description"]) data.description = block["description"];
      if (!data.rating) {
        const agg = block["aggregateRating"] as Record<string, unknown>;
        if (agg) {
          const r = parseFloat(String(agg["ratingValue"] ?? "")); if (!isNaN(r)) data.rating = r;
          const rc = parseInt(String(agg["reviewCount"] ?? ""), 10); if (!isNaN(rc)) data.review_count = rc;
        }
      }
      if (!data.images) {
        const img = block["image"];
        if (typeof img === "string") data.images = [img];
        else if (Array.isArray(img)) data.images = img.filter((i) => typeof i === "string");
      }
    }

    if ((schemaName === "article" || schemaName === "blog") &&
        (type === "article" || type === "newsarticle" || type === "blogposting")) {
      if (!data.title && block["headline"]) data.title = block["headline"];
      if (!data.author) { const a = block["author"] as Record<string, unknown>; if (a?.["name"]) data.author = a["name"]; }
      if (!data.published_date && block["datePublished"]) data.published_date = block["datePublished"];
      if (!data.summary && block["description"]) data.summary = block["description"];
    }
  }
}

// ─── Stage 3: Meta fallbacks ──────────────────────────────────────────────────
function applyMetaFallbacks($: cheerio.CheerioAPI, schemaName: string, data: Record<string, unknown>): void {
  const og = (p: string) => $(`meta[property="og:${p}"]`).attr("content")?.trim();
  const meta = (n: string) => $(`meta[name="${n}"]`).attr("content")?.trim();

  if (schemaName === "product") {
    if (!data.product_name) data.product_name = og("title") || meta("title");
    if (!data.description) data.description = og("description") || meta("description");
    if (!data.images) { const img = og("image"); if (img) data.images = [img]; }
    if (!data.price) { const p = $("meta[property='product:price:amount']").attr("content"); if (p) { const n = parseFloat(p); if (!isNaN(n)) data.price = n; } }
    if (!data.currency) { const c = $("meta[property='product:price:currency']").attr("content"); if (c) data.currency = c; }
  }

  if (schemaName === "article" || schemaName === "blog" || schemaName === "saas_ideas") {
    if (!data.title && !data.page_title) {
      const t = og("title") || meta("title");
      if (t) { schemaName === "saas_ideas" ? (data.page_title = t) : (data.title = t); }
    }
    if (!data.summary) data.summary = og("description") || meta("description");
    if (!data.author) data.author = meta("author");
    if (!data.published_date) {
      const d = $("meta[property='article:published_time']").attr("content") || meta("date");
      if (d) data.published_date = d;
    }
  }
}

// ─── Stage 4: Smart heuristics ────────────────────────────────────────────────

// Generic phrases that are NOT ideas — nav items, CTAs, marketing copy
const IDEA_BLOCKLIST = new Set([
  "recent posts", "make something people want", "sign in", "sign up", "log in",
  "get started", "learn more", "read more", "view all", "see all", "subscribe",
  "newsletter", "follow us", "share this", "related posts", "you might also like",
  "tags", "categories", "search", "menu", "navigation", "footer", "header",
  "cookie", "privacy policy", "terms of service", "copyright", "all rights reserved",
  "back to top", "load more", "show more", "previous", "next", "page",
]);

function isGoodIdea(text: string): boolean {
  const t = text.trim();
  if (t.length < 15) return false;        // Too short — nav items
  if (t.length > 200) return false;       // Too long — paragraphs
  if (t.split(" ").length < 3) return false; // Less than 3 words — probably a label
  if (IDEA_BLOCKLIST.has(t.toLowerCase())) return false;
  if (/^(home|blog|about|contact|product|service|pricing|company)$/i.test(t)) return false;
  if (/^\d+$/.test(t)) return false; // Pure numbers
  return true;
}

function applyHeuristics($: cheerio.CheerioAPI, schemaName: string, data: Record<string, unknown>): void {
  if (schemaName === "product") {
    if (!data.product_name) data.product_name = $("h1").first().text().trim() || undefined;
    if (!data.description) {
      $("p").each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 40 && !data.description) data.description = t;
      });
    }
  }

  if (schemaName === "article" || schemaName === "blog") {
    if (!data.title) data.title = $("h1").first().text().trim() || $("title").text().trim() || undefined;
    if (!data.key_points || (data.key_points as unknown[]).length === 0) {
      const headings: string[] = [];
      $("h2, h3").each((_, el) => { const t = $(el).text().trim(); if (t.length > 5) headings.push(t); });
      if (headings.length) data.key_points = headings.slice(0, 10);
    }
    if (!data.word_count) {
      const body = $("article, main, .post-content, .entry-content").first().text();
      if (body) data.word_count = body.trim().split(/\s+/).length;
    }
  }

  if (schemaName === "saas_ideas") {
    // Extract ideas from article headings — filter noise aggressively
    if (!data.ideas || (data.ideas as unknown[]).length === 0) {
      const headings: string[] = [];

      // Priority order: article body > index cards > any heading
      const selectors = [
        ".gh-content h2", ".gh-content h3",
        ".post-content h2", ".post-content h3",
        ".entry-content h2", ".entry-content h3",
        // YC blog uses article tags
        "article h2", "article h3",
        // Generic
        "main h2", "main h3",
        // Index page card titles
        ".gh-card-title", ".post-card-title",
        // YC's React blog renders titles as links inside article lists
        "article a[href*='/blog/']",
        "a.post-title", "a.article-title",
        // HN-style lists
        ".title a", ".storylink",
      ];

      for (const sel of selectors) {
        $(sel).each((_, el) => {
          const t = $(el).text().trim().replace(/\s+/g, " ");
          if (isGoodIdea(t) && !headings.includes(t)) headings.push(t);
        });
        if (headings.length >= 5) break; // Found enough quality headings
      }

      if (headings.length > 0) data.ideas = headings.slice(0, 30);
    } else {
      // Filter existing ideas array to remove noise
      data.ideas = (data.ideas as string[]).filter(isGoodIdea).slice(0, 30);
    }

    // Article URLs from the page (for crawl discovery)
    if (!data.article_urls) {
      const urls: string[] = [];
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href") ?? "";
        const text = $(el).text().trim();
        if (href.startsWith("/") && !href.includes("#") && text.length > 15 && !urls.includes(href)) {
          urls.push(href);
        }
      });
      if (urls.length) data.article_urls = urls.slice(0, 20);
    }

    // Filter article_urls — remove obvious non-article paths
    if (data.article_urls) {
      data.article_urls = (data.article_urls as string[]).filter((u) => {
        return !u.match(/\/(about|contact|pricing|signin|signup|login|logout|subscribe|tag|author|category|page|rss|feed|cdn|static|api)\//i)
          && !u.match(/\.(css|js|png|jpg|svg|ico|pdf)$/i);
      });
    }

    // Summary from meta if not found
    if (!data.summary) {
      const desc = $("meta[name='description']").attr("content")?.trim();
      if (desc && desc.length > 20) data.summary = desc;
    }
  }
}
