/**
 * extractor-cheerio.ts
 * Traditional CSS selector extraction engine using Cheerio.
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { SelectorSchema } from "./selectors";
import { SELECTOR_MAP } from "./selectors";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheerioResult<T = Record<string, unknown>> {
  data: T;
  confidence: number;
  fieldStats: { found: string[]; missing: string[] };
  structuredData: unknown[];
  interceptedData?: unknown[];
  durationMs: number;
}

// ─── JSON-LD / Microdata extractor ───────────────────────────────────────────

function extractStructuredData($: CheerioAPI): unknown[] {
  const results: unknown[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html() ?? "";
      const parsed = JSON.parse(raw);
      results.push(parsed);
    } catch { /* invalid JSON — skip */ }
  });

  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const prop = $(el).attr("property")?.replace("og:", "") ?? "";
    const content = $(el).attr("content") ?? "";
    if (prop && content) og[prop] = content;
  });
  if (Object.keys(og).length > 0) results.push({ "@type": "OpenGraph", ...og });

  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const name = $(el).attr("name")?.replace("twitter:", "") ?? "";
    const content = $(el).attr("content") ?? "";
    if (name && content) twitter[name] = content;
  });
  if (Object.keys(twitter).length > 0) results.push({ "@type": "TwitterCard", ...twitter });

  return results;
}

// ─── Field extractor ──────────────────────────────────────────────────────────

function extractField($: CheerioAPI, field: SelectorSchema[string]): unknown {
  const { selectors, extract = "text", attr, multiple = false, transform } = field;

  for (const selector of selectors) {
    try {
      const els = $(selector);
      if (els.length === 0) continue;

      if (multiple) {
        const values: string[] = [];
        els.each((_, el) => {
          let val = "";
          if (extract === "text") val = $(el).text().trim();
          else if (extract === "href") val = $(el).attr("href") ?? "";
          else if (extract === "src") val = $(el).attr("src") ?? "";
          else if (extract === "attr" && attr) val = $(el).attr(attr) ?? "";
          else if (extract === "html") val = $(el).html() ?? "";
          if (val) values.push(val);
        });
        if (values.length > 0) {
          return transform ? values.map((v) => transform(v)) : values;
        }
        continue;
      }

      const el = els.first();
      let val = "";
      if (extract === "text") val = el.text().trim();
      else if (extract === "href") val = el.attr("href") ?? "";
      else if (extract === "src") val = el.attr("src") ?? "";
      else if (extract === "attr" && attr) val = el.attr(attr) ?? "";
      else if (extract === "html") val = el.html() ?? "";
      else if (extract === "number") val = el.text().trim();
      else if (extract === "boolean") val = el.text().trim();

      if (val) return transform ? transform(val) : val;
    } catch { /* bad selector — try next */ }
  }

  return multiple ? [] : null;
}

// ─── Heuristic content extractor ─────────────────────────────────────────────

function extractHeuristicContent($: CheerioAPI): {
  headings: string[];
  paragraphs: string[];
  lists: string[][];
  links: Array<{ text: string; href: string }>;
  tables: Array<Record<string, string>[]>;
} {
  $("script, style, nav, footer, header, aside, iframe, .cookie-banner, .ad, .advertisement").remove();

  const headings: string[] = [];
  $("h1, h2, h3").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 2 && text.length < 200) headings.push(text);
  });

  const paragraphs: string[] = [];
  $("p").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 40) paragraphs.push(text);
  });

  const lists: string[][] = [];
  $("ul, ol").each((_, listEl) => {
    const items: string[] = [];
    $(listEl).find("li").each((_, li) => {
      const text = $(li).text().trim();
      if (text.length > 2) items.push(text);
    });
    if (items.length > 0) lists.push(items);
  });

  const links: Array<{ text: string; href: string }> = [];
  $("a[href]").each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr("href") ?? "";
    if (text.length > 2 && href && !href.startsWith("#")) {
      links.push({ text, href });
    }
  });

  const tables: Array<Record<string, string>[]> = [];
  $("table").each((_, tableEl) => {
    const headers: string[] = [];
    $(tableEl).find("th").each((_, th) => { headers.push($(th).text().trim()); });
    if (headers.length === 0) return;

    const rows: Record<string, string>[] = [];
    $(tableEl).find("tr").each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length === 0) return;
      const row: Record<string, string> = {};
      cells.each((i, td) => { row[headers[i] ?? `col_${i}`] = $(td).text().trim(); });
      rows.push(row);
    });
    if (rows.length > 0) tables.push(rows);
  });

  return { headings, paragraphs, lists, links, tables };
}

// ─── Pricing extractor ────────────────────────────────────────────────────────

function extractPricingTiers($: CheerioAPI): unknown[] {
  const tiers: unknown[] = [];
  const cardSelectors = [
    ".pricing-card", ".price-card", ".plan-card", ".pricing-plan",
    "[class*='pricing'] [class*='plan']", "[class*='plan-']", "[class*='tier']", ".card",
  ];

  for (const sel of cardSelectors) {
    const cards = $(sel);
    if (cards.length < 2) continue;

    cards.each((_, card) => {
      const $card = $(card);
      const name = $card.find("h2, h3, h4, .plan-name, .tier-name, [class*='title']").first().text().trim();
      if (!name) return;
      const priceText = $card.find(".price, [class*='price'], [class*='amount'], [class*='cost']").first().text().trim();
      const price = parseFloat(priceText.replace(/[^0-9.]/g, "")) || null;
      const features: string[] = [];
      $card.find("li, [class*='feature']").each((_, li) => {
        const text = $(li).text().trim();
        if (text.length > 2) features.push(text);
      });
      const isPopular =
        $card.find("[class*='popular'], [class*='recommended'], [class*='featured']").length > 0 ||
        /popular|recommended|best/i.test($card.attr("class") ?? "");
      tiers.push({
        tier_name: name,
        price_monthly: price,
        features,
        is_popular: isPopular,
        has_free_trial: /free trial|try free|no credit card/i.test($card.text()),
      });
    });

    if (tiers.length > 0) break;
  }

  return tiers;
}

// ─── Review extractor ─────────────────────────────────────────────────────────

function extractReviews($: CheerioAPI): unknown[] {
  const reviews: unknown[] = [];
  const reviewSelectors = [
    ".review", "[itemprop='review']", ".testimonial", ".comment",
    "[class*='review-item']", "[class*='review-card']",
  ];

  for (const sel of reviewSelectors) {
    const els = $(sel);
    if (els.length === 0) continue;

    els.each((_, el) => {
      const $el = $(el);
      const ratingText = $el.find("[itemprop='ratingValue'], .rating, .stars, [class*='rating']").first().text().trim();
      const rating = parseFloat(ratingText) || null;
      const reviewText = $el.find("[itemprop='reviewBody'], .review-body, .review-text, p").first().text().trim();
      const name = $el.find("[itemprop='author'], .reviewer, .author, .name").first().text().trim();
      const date = $el.find("time[datetime]").first().attr("datetime")
        ?? $el.find(".date, .review-date").first().text().trim();
      if (reviewText.length > 10) {
        reviews.push({ reviewer_name: name || null, rating, review_text: reviewText, date: date || null, pros: [], cons: [] });
      }
    });

    if (reviews.length > 0) break;
  }

  return reviews;
}

// ─── JSON-LD → flat fields promoter ──────────────────────────────────────────

function promoteFromStructuredData(
  structuredData: unknown[],
  data: Record<string, unknown>,
  schemaKey: string
): void {
  for (const block of structuredData) {
    const items: unknown[] = (block as any)?.["@graph"]
      ? [(block as any)["@graph"]].flat()
      : [block];

    for (const item of items) {
      const type = (item as any)?.["@type"] ?? "";

      // Product
      if (schemaKey === "product" && /product/i.test(type)) {
        if (!data.product_name && (item as any).name) data.product_name = (item as any).name;
        if (!data.description && (item as any).description) data.description = (item as any).description;
        if (!data.sku && (item as any).sku) data.sku = (item as any).sku;
        if (!data.images && (item as any).image) data.images = [(item as any).image].flat();
        const aggRating = (item as any).aggregateRating;
        if (aggRating) {
          if (!data.rating) data.rating = parseFloat(aggRating.ratingValue) || null;
          if (!data.review_count) data.review_count = parseInt(aggRating.reviewCount, 10) || null;
        }
        const offers = [(item as any).offers ?? []].flat();
        if (offers.length > 0) {
          const offer = offers[0] as any;
          if (!data.price && offer.price) data.price = parseFloat(offer.price) || null;
          if (!data.currency && offer.priceCurrency) data.currency = offer.priceCurrency;
          if (data.in_stock === undefined || data.in_stock === null) {
            data.in_stock = !/OutOfStock/i.test(offer.availability ?? "");
          }
          if (offers.length > 1) {
            const prices = offers.map((o: any) => parseFloat(o.price)).filter(Boolean);
            data.price_min = Math.min(...prices);
            data.price_max = Math.max(...prices);
          }
        }
      }

      // Article
      if ((schemaKey === "article" || schemaKey === "blog") &&
          /article|blogposting|newsarticle/i.test(type)) {
        if (!data.title && (item as any).headline) data.title = (item as any).headline;
        if (!data.author) {
          const author = (item as any).author;
          data.author = typeof author === "string" ? author : (author?.name ?? null);
        }
        if (!data.published_date && (item as any).datePublished)
          data.published_date = (item as any).datePublished;
        if (!data.summary && (item as any).description)
          data.summary = (item as any).description;
      }

      // Job
      if (schemaKey === "job" && /jobposting/i.test(type)) {
        if (!data.title && (item as any).title) data.title = (item as any).title;
        if (!data.company && (item as any).hiringOrganization?.name)
          data.company = (item as any).hiringOrganization.name;
        if (!data.location && (item as any).jobLocation?.address?.addressLocality)
          data.location = (item as any).jobLocation.address.addressLocality;
        if (!data.posted_date && (item as any).datePosted)
          data.posted_date = (item as any).datePosted;
        if (!data.employment_type && (item as any).employmentType)
          data.employment_type = (item as any).employmentType;
        const baseSalary = (item as any).baseSalary;
        if (baseSalary) {
          data.salary_min = baseSalary.value?.minValue ?? null;
          data.salary_max = baseSalary.value?.maxValue ?? null;
          data.salary_currency = baseSalary.currency ?? null;
        }
      }

      // Review aggregate
      if (schemaKey === "review" && (item as any).aggregateRating) {
        const agg = (item as any).aggregateRating;
        if (!data.overall_rating) data.overall_rating = parseFloat(agg.ratingValue) || null;
        if (!data.total_reviews) data.total_reviews = parseInt(agg.reviewCount, 10) || null;
      }

      // OpenGraph fallback
      if (type === "OpenGraph") {
        if (!data.title && (item as any).title) data.title = (item as any).title;
        if (!data.description && (item as any).description) data.description = (item as any).description;
        if (!data.images && (item as any).image) data.images = [(item as any).image];
      }
    }
  }
}

// ─── Main extraction function ─────────────────────────────────────────────────

export function extractWithCheerio<T = Record<string, unknown>>(
  html: string,
  schemaKey: string,
  interceptedJson?: unknown[]
): CheerioResult<T> {
  const start = Date.now();
  const $ = cheerio.load(html);
  const selectorSchema = SELECTOR_MAP[schemaKey] ?? SELECTOR_MAP["generic"];
  const data: Record<string, unknown> = {};
  const found: string[] = [];
  const missing: string[] = [];

  // 1. CSS selector rules
  for (const [fieldName, fieldDef] of Object.entries(selectorSchema)) {
    const value = extractField($, fieldDef);
    const isEmpty = value === null || value === undefined ||
      (Array.isArray(value) && value.length === 0) || value === "";
    if (!isEmpty) { data[fieldName] = value; found.push(fieldName); }
    else { missing.push(fieldName); }
  }

  // 2. Schema-specific extractors
  if (schemaKey === "pricing") {
    const tiers = extractPricingTiers($);
    if (tiers.length > 0) {
      data.tiers = tiers;
      data.has_free_plan = tiers.some((t: any) => t.price_monthly === 0 || /free/i.test(t.tier_name));
      found.push("tiers");
    }
  }

  if (schemaKey === "review") {
    const reviews = extractReviews($);
    if (reviews.length > 0) { data.reviews = reviews; found.push("reviews"); }
  }

  // 3. Heuristic content for article/blog/generic schemas
  if (["saas_ideas", "blog", "article", "generic"].includes(schemaKey)) {
    const heuristic = extractHeuristicContent($);
    if (!data.title && heuristic.headings[0]) data.title = heuristic.headings[0];
    if (heuristic.headings.length > 0) data.headings = heuristic.headings;
    if (heuristic.paragraphs.length > 0) data.paragraphs = heuristic.paragraphs.slice(0, 10);
    if (heuristic.lists.length > 0) data.lists = heuristic.lists;
    if (heuristic.tables.length > 0) data.tables = heuristic.tables;
    if (heuristic.links.length > 0) data.links = heuristic.links.slice(0, 20);
  }

  // 4. Product table → clean key-value features
  if (schemaKey === "product" && (!data.features || (data.features as string[]).length === 0)) {
    const tableFeatures: string[] = [];
    $("table").each((_: any, tableEl: any) => {
      $(tableEl).find("tr").each((_: any, tr: any) => {
        const th = $(tr).find("th").text().trim();
        const td = $(tr).find("td").text().trim().replace(/\s+/g, " ");
        if (th && td && th.length < 50) tableFeatures.push(th + ": " + td);
      });
    });
    if (tableFeatures.length > 0) {
      data.features = tableFeatures;
      if (!found.includes("features")) found.push("features");
      const idx = missing.indexOf("features");
      if (idx > -1) missing.splice(idx, 1);
    }
  }

  // 5. JSON-LD structured data
  const structuredData = extractStructuredData($);

  // 6. Promote JSON-LD fields to top-level
  if (structuredData.length > 0) {
    promoteFromStructuredData(structuredData, data, schemaKey);
    for (let i = missing.length - 1; i >= 0; i--) {
      const f = missing[i];
      if (data[f] !== undefined && data[f] !== null && data[f] !== "") {
        missing.splice(i, 1);
        if (!found.includes(f)) found.push(f);
      }
    }
  }

  // 7. Intercepted JSON
  if (interceptedJson && interceptedJson.length > 0) {
    data.intercepted_api_data = interceptedJson;
    found.push("intercepted_api_data");
  }

  const confidence = found.length / Math.max(found.length + missing.length, 1);

  return {
    data: data as T,
    confidence,
    fieldStats: { found, missing },
    structuredData,
    interceptedData: interceptedJson,
    durationMs: Date.now() - start,
  };
}