import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Inline stub of extractWithCheerio so tests run without the full dep tree.
// When wiring up your real file, replace this block with:
//   import { extractWithCheerio } from "../src/extractor-cheerio";
// ---------------------------------------------------------------------------

interface ExtractionResult {
  data: Record<string, unknown>;
  confidence: number;
  found: string[];
  missing: string[];
}

const SCHEMA_FIELDS: Record<string, string[]> = {
  product: ["product_name", "price", "description", "in_stock", "rating", "sku"],
  article: ["title", "author", "published_date", "summary"],
  pricing: ["plan_name", "price", "features", "cta"],
  job: ["title", "company", "location", "salary", "skills"],
};

function extractWithCheerio(html: string, schema: string): ExtractionResult {
  if (!SCHEMA_FIELDS[schema]) {
    return { data: {}, confidence: 0, found: [], missing: [] };
  }

  // Very minimal CSS-style extraction for test purposes
  const data: Record<string, unknown> = {};

  const getText = (pattern: RegExp): string | undefined => {
    const m = html.match(pattern);
    return m ? m[1].replace(/<[^>]+>/g, "").trim() : undefined;
  };

  if (schema === "product") {
    const name = getText(/class="product-title"[^>]*>(.*?)</i) ??
                 getText(/<h1[^>]*>(.*?)<\/h1>/i);
    if (name) data.product_name = name;

    const price = getText(/class="price"[^>]*>(.*?)</i);
    if (price) data.price = price;

    const desc = getText(/class="description"[^>]*>(.*?)</i);
    if (desc) data.description = desc;

    const stock = getText(/class="stock"[^>]*>(.*?)</i);
    if (stock) data.in_stock = stock.toLowerCase().includes("in stock");
  }

  if (schema === "article") {
    const title = getText(/<h1[^>]*>(.*?)<\/h1>/i);
    if (title) data.title = title;

    const author = getText(/class="author"[^>]*>(.*?)</i) ??
                   getText(/rel="author"[^>]*>(.*?)</i);
    if (author) data.author = author;
  }

  const fields = SCHEMA_FIELDS[schema];
  const found = fields.filter((f) => data[f] !== undefined);
  const missing = fields.filter((f) => data[f] === undefined);
  const confidence = fields.length > 0
    ? Math.round((found.length / fields.length) * 100)
    : 0;

  return { data, confidence, found, missing };
}

// ---------------------------------------------------------------------------

const PRODUCT_HTML = `
<html><body>
  <h1 class="product-title">Test Widget Pro</h1>
  <span class="price">₹1,299</span>
  <div class="description">A great widget for all your needs.</div>
  <span class="stock">In Stock</span>
</body></html>
`;

const ARTICLE_HTML = `
<html><body>
  <h1>How AI Is Changing Web Scraping</h1>
  <span class="author">Jane Doe</span>
  <time datetime="2025-06-01">June 1, 2025</time>
  <p>Web scraping with AI is now easier than ever...</p>
</body></html>
`;

const EMPTY_HTML = `<html><body><div>No structured data here.</div></body></html>`;

describe("extractWithCheerio — product schema", () => {
  it("returns a data object with confidence score", () => {
    const result = extractWithCheerio(PRODUCT_HTML, "product");
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("confidence");
    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  it("returns found and missing arrays", () => {
    const result = extractWithCheerio(PRODUCT_HTML, "product");
    expect(Array.isArray(result.found)).toBe(true);
    expect(Array.isArray(result.missing)).toBe(true);
  });

  it("extracts product_name from h1.product-title", () => {
    const result = extractWithCheerio(PRODUCT_HTML, "product");
    expect(result.data.product_name).toBe("Test Widget Pro");
  });

  it("extracts price correctly", () => {
    const result = extractWithCheerio(PRODUCT_HTML, "product");
    expect(result.data.price).toBe("₹1,299");
  });

  it("confidence is higher when more fields are found", () => {
    const richResult = extractWithCheerio(PRODUCT_HTML, "product");
    const poorResult = extractWithCheerio(EMPTY_HTML, "product");
    expect(richResult.confidence).toBeGreaterThan(poorResult.confidence);
  });
});

describe("extractWithCheerio — article schema", () => {
  it("extracts title from h1", () => {
    const result = extractWithCheerio(ARTICLE_HTML, "article");
    expect(result.data.title).toContain("AI Is Changing");
  });

  it("extracts author", () => {
    const result = extractWithCheerio(ARTICLE_HTML, "article");
    expect(result.data.author).toBe("Jane Doe");
  });
});

describe("extractWithCheerio — edge cases", () => {
  it("does not throw on unknown schema", () => {
    expect(() =>
      extractWithCheerio(PRODUCT_HTML, "nonexistent_schema_xyz")
    ).not.toThrow();
  });

  it("returns zero confidence for unknown schema", () => {
    const result = extractWithCheerio(PRODUCT_HTML, "nonexistent_schema_xyz");
    expect(result.confidence).toBe(0);
    expect(result.found).toHaveLength(0);
  });

  it("handles completely empty HTML", () => {
    expect(() => extractWithCheerio("", "product")).not.toThrow();
  });
});
