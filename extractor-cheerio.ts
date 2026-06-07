/**
 * extractor-cheerio.ts
 * Cheerio-based extraction engine — zero AI, ~1ms per page.
 *
 * Extraction order (each layer fills missing fields):
 *  1. CSS selectors (from selectors.ts registry)
 *  2. JSON-LD structured data (Product, Article, JobPosting, etc.)
 *  3. OpenGraph / Twitter card meta tags
 *  4. Heuristic fallbacks (tables, headings, first paragraph)
 *
 * structured_data is NEVER written to the output — it's used internally
 * to promote fields, then discarded.
 */

import * as cheerio from "cheerio";
import { SCHEMA_RULES, WORD_RATINGS } from "./selectors";
import type { SchemaRules } from "./selectors";

export interface CheerioResult {
  data: Record<string, unknown>;
  confidence: number;   // 0–100: how many schema fields were found
  found: string[];
  missing: string[];
  method: "cheerio";
  durationMs: number;
}

// ─── Main entry point ─────────────────────────────────────────────────────────
export function extractWithCheerio(
  html: string,
  schemaName: string
): CheerioResult {
  const start = Date.now();
  const rules = SCHEMA_RULES[schemaName];
  if (!rules) throw new Error(`Unknown schema: "${schemaName}"`);

  const $ = cheerio.load(html);
  const data: Record<string, unknown> = {};

  // Stage 1: CSS selector extraction
  applyCssRules($, rules, data);

  // Stage 2: JSON-LD promotion (internal — never written to data as-is)
  const jsonLd = extractJsonLd($);
  promoteFromJsonLd(jsonLd, schemaName, data);

  // Stage 3: OpenGraph / meta tag fallbacks
  applyMetaFallbacks($, schemaName, data);

  // Stage 4: Heuristic fallbacks for still-missing fields
  applyHeuristics($, schemaName, data);

  // Clean empty values
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (
      val === "" ||
      val === null ||
      val === undefined ||
      (Array.isArray(val) && val.length === 0)
    ) {
      delete data[key];
    }
  }

  // Confidence = fields found / total schema fields
  const schemaFields = Object.keys(rules);
  const found = schemaFields.filter((f) => data[f] !== undefined);
  const missing = schemaFields.filter((f) => data[f] === undefined);
  const confidence = Math.round((found.length / schemaFields.length) * 100);

  return {
    data,
    confidence,
    found,
    missing,
    method: "cheerio",
    durationMs: Date.now() - start,
  };
}

// ─── Stage 1: CSS rules ───────────────────────────────────────────────────────
function applyCssRules(
  $: cheerio.CheerioAPI,
  rules: SchemaRules,
  data: Record<string, unknown>
): void {
  for (const [field, rule] of Object.entries(rules)) {
    for (const sel of rule.selectors) {
      const el = $(sel).first();
      if (!el.length) continue;

      let value: unknown;

      switch (rule.type) {
        case "text": {
          const text = el.text().trim();
          if (text) { value = text; }
          break;
        }

        case "attr": {
          const attr = el.attr(rule.attr)?.trim();
          if (attr) { value = attr; }
          break;
        }

        case "number": {
          const raw = el.attr("content") || el.text();
          const num = parseFloat(raw.replace(/[^0-9.]/g, ""));
          if (!isNaN(num)) { value = num; }
          break;
        }

        case "bool": {
          // Check for class-based availability (e.g. .instock element existing = in stock)
          const text = el.text().toLowerCase().trim();
          const className = el.attr("class")?.toLowerCase() || "";
          const trueVals = rule.trueValues ?? ["in stock", "available"];

          if (className.includes("instock") || trueVals.some((v) => text.includes(v))) {
            value = true;
          } else if (text.includes("out of stock") || text.includes("unavailable")) {
            value = false;
          } else if (el.length) {
            // Element exists — assume in stock (e.g. cart button present)
            value = true;
          }
          break;
        }

        case "rating": {
          // Try numeric content/text first
          const numStr = el.attr("content") || el.text();
          const num = parseFloat(numStr.replace(/[^0-9.]/g, ""));
          if (!isNaN(num) && num > 0) {
            value = num;
            break;
          }
          // Fall back to word-class encoding (e.g. "star-rating Three" → 3)
          const cls = el.attr("class") || "";
          for (const [word, rating] of Object.entries(WORD_RATINGS)) {
            if (cls.includes(word)) {
              value = rating;
              break;
            }
          }
          break;
        }

        case "list": {
          // Collect all matching elements — filter noise
          const items: string[] = [];
          $(sel).each((_, elem) => {
            const text = $(elem).text().trim().replace(/\s+/g, " ");
            // Skip: empty, too short (nav items), too long (paragraphs), duplicates
            if (
              text &&
              text.length >= 8 &&
              text.length <= 300 &&
              !items.includes(text)
            ) {
              items.push(text);
            }
          });
          if (items.length > 0) {
            value = rule.limit ? items.slice(0, rule.limit) : items;
          }
          break;
        }

        case "table": {
          // Parse key-value table rows into a clean object
          const tableData: Record<string, string> = {};
          const tableEl = $(sel);

          // Handle both <table> and <tr> selectors
          const rows = tableEl.is("tr") ? tableEl : tableEl.find("tr");

          rows.each((_, row) => {
            const cells = $(row).find("td, th");
            if (cells.length >= 2) {
              const key = $(cells[0]).text().trim().replace(/\s+/g, " ");
              const val = $(cells[1]).text().trim().replace(/\s+/g, " ");
              if (key && val) {
                tableData[key] = val;
              }
            }
          });

          // Also handle <li> selectors for bullet-point features
          if (Object.keys(tableData).length === 0) {
            const items: string[] = [];
            $(sel).each((_, elem) => {
              const text = $(elem).text().trim();
              if (text) items.push(text);
            });
            if (items.length > 0) {
              value = rule.limit ? items.slice(0, rule.limit) : items;
              break;
            }
          }

          if (Object.keys(tableData).length > 0) {
            value = tableData;
          }
          break;
        }
      }

      if (value !== undefined) {
        data[field] = value;
        break; // First selector that returns a value wins
      }
    }
  }
}

// ─── Stage 2: JSON-LD extraction ──────────────────────────────────────────────
function extractJsonLd($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html()?.trim() || "";
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        results.push(...parsed);
      } else {
        results.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  });

  return results;
}

// ─── Stage 2: Promote JSON-LD fields into data (no raw dump) ─────────────────
function promoteFromJsonLd(
  jsonLd: Record<string, unknown>[],
  schemaName: string,
  data: Record<string, unknown>
): void {
  for (const block of jsonLd) {
    const type = (block["@type"] as string)?.toLowerCase() || "";

    if (schemaName === "product" && (type === "product" || type.includes("product"))) {
      // Price from offers
      if (!data.price) {
        const offers = block["offers"] as Record<string, unknown> | undefined;
        if (offers) {
          const price = parseFloat(String(offers["price"] ?? ""));
          if (!isNaN(price)) data.price = price;

          if (!data.currency) {
            const cur = offers["priceCurrency"] as string | undefined;
            if (cur) data.currency = cur;
          }

          if (!data.in_stock) {
            const avail = String(offers["availability"] ?? "").toLowerCase();
            if (avail.includes("instock") || avail.includes("in_stock")) {
              data.in_stock = true;
            } else if (avail.includes("outofstock")) {
              data.in_stock = false;
            }
          }
        }
      }

      if (!data.sku && block["sku"]) data.sku = block["sku"];
      if (!data.brand) {
        const brand = block["brand"] as Record<string, unknown> | undefined;
        if (brand?.["name"]) data.brand = brand["name"];
      }
      if (!data.description && block["description"]) {
        data.description = block["description"];
      }

      // Rating
      if (!data.rating) {
        const agg = block["aggregateRating"] as Record<string, unknown> | undefined;
        if (agg) {
          const r = parseFloat(String(agg["ratingValue"] ?? ""));
          if (!isNaN(r)) data.rating = r;
          const rc = parseInt(String(agg["reviewCount"] ?? ""), 10);
          if (!isNaN(rc)) data.review_count = rc;
        }
      }

      // Images
      if (!data.images) {
        const img = block["image"];
        if (typeof img === "string") data.images = [img];
        else if (Array.isArray(img)) data.images = img.filter((i) => typeof i === "string");
      }
    }

    if (schemaName === "article" && (type === "article" || type.includes("article") || type === "newsarticle" || type === "blogposting")) {
      if (!data.title && block["headline"]) data.title = block["headline"];
      if (!data.author) {
        const a = block["author"] as Record<string, unknown> | undefined;
        if (a?.["name"]) data.author = a["name"];
      }
      if (!data.published_date && block["datePublished"]) {
        data.published_date = block["datePublished"];
      }
      if (!data.summary && block["description"]) data.summary = block["description"];
    }

    if (schemaName === "job" && type === "jobposting") {
      if (!data.title && block["title"]) data.title = block["title"];
      if (!data.company) {
        const org = block["hiringOrganization"] as Record<string, unknown> | undefined;
        if (org?.["name"]) data.company = org["name"];
      }
      if (!data.location) {
        const loc = block["jobLocation"] as Record<string, unknown> | undefined;
        const address = loc?.["address"] as Record<string, unknown> | undefined;
        if (address?.["addressLocality"]) data.location = address["addressLocality"];
      }
      if (!data.description && block["description"]) data.description = block["description"];
    }
  }
}

// ─── Stage 3: Meta tag fallbacks ──────────────────────────────────────────────
function applyMetaFallbacks(
  $: cheerio.CheerioAPI,
  schemaName: string,
  data: Record<string, unknown>
): void {
  const og = (prop: string) =>
    $(`meta[property="og:${prop}"]`).attr("content")?.trim() ||
    $(`meta[name="${prop}"]`).attr("content")?.trim();

  const meta = (name: string) =>
    $(`meta[name="${name}"]`).attr("content")?.trim();

  if (schemaName === "product") {
    if (!data.product_name) data.product_name = og("title") || meta("title");
    if (!data.description) data.description = og("description") || meta("description");
    if (!data.images) {
      const img = og("image");
      if (img) data.images = [img];
    }
    if (!data.price) {
      const priceStr = $("meta[property='product:price:amount']").attr("content");
      if (priceStr) {
        const num = parseFloat(priceStr);
        if (!isNaN(num)) data.price = num;
      }
    }
    if (!data.currency) {
      const cur = $("meta[property='product:price:currency']").attr("content");
      if (cur) data.currency = cur;
    }
  }

  if (schemaName === "article" || schemaName === "blog") {
    if (!data.title) data.title = og("title") || meta("title");
    if (!data.summary) data.summary = og("description") || meta("description");
    if (!data.author) data.author = meta("author");
  }

  if (schemaName === "company") {
    if (!data.name) data.name = og("site_name");
    if (!data.description) data.description = og("description") || meta("description");
  }
}

// ─── Stage 4: Heuristic fallbacks ────────────────────────────────────────────
function applyHeuristics(
  $: cheerio.CheerioAPI,
  schemaName: string,
  data: Record<string, unknown>
): void {
  if (schemaName === "product") {
    // Fallback: first <h1> for product name
    if (!data.product_name) {
      data.product_name = $("h1").first().text().trim() || undefined;
    }
    // Fallback: first real paragraph for description
    if (!data.description) {
      $("p").each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 40 && !data.description) {
          data.description = text;
        }
      });
    }
  }

  if (schemaName === "article" || schemaName === "blog") {
    if (!data.title) {
      data.title = $("h1").first().text().trim() || $("title").text().trim() || undefined;
    }
    if (!data.key_points || (data.key_points as unknown[]).length === 0) {
      const headings: string[] = [];
      $("h2, h3").each((_, el) => {
        const text = $(el).text().trim();
        if (text) headings.push(text);
      });
      if (headings.length) data.key_points = headings.slice(0, 10);
    }
    // Word count estimate
    if (!data.word_count) {
      const body = $("article, main, .post-content, .entry-content").first().text();
      if (body) {
        data.word_count = body.trim().split(/\s+/).length;
      }
    }
  }

  if (schemaName === "saas_ideas") {
    // Collect ideas from article body headings first, then index card titles
    if (!data.ideas || (data.ideas as unknown[]).length === 0) {
      const headings: string[] = [];
      const selPriority = [
        ".gh-content h2", ".gh-content h3",
        ".post-content h2", ".post-content h3",
        ".gh-card-title", ".post-card-title",
        "article h2", "article h3",
        "h2", "h3",
      ];
      for (const sel of selPriority) {
        $(sel).each((_, el) => {
          const text = $(el).text().trim().replace(/\s+/g, " ");
          if (text.length >= 10 && text.length <= 200 && !headings.includes(text)) {
            headings.push(text);
          }
        });
        if (headings.length >= 3) break;
      }
      if (headings.length) data.ideas = headings.slice(0, 30);
    }

    // Summary fallback from meta description
    if (!data.summary) {
      const desc = $("meta[name='description']").attr("content")?.trim();
      if (desc) data.summary = desc;
    }

    // Collect article URLs from index page link text
    if (!data.article_urls) {
      const urls: string[] = [];
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href") || "";
        const text = $(el).text().trim();
        if (
          href.startsWith("/") &&
          !href.includes("#") &&
          text.length > 15 &&
          !urls.includes(href)
        ) {
          urls.push(href);
        }
      });
      if (urls.length) data.article_urls = urls.slice(0, 20);
    }
  }
}
