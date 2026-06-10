import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Sitemap parsing tests — these test the parsing logic directly (no network).
// When you integrate with src/sitemap.ts, you can add an additional describe
// block that imports and calls discoverFromSitemap() against a local server.
// ---------------------------------------------------------------------------

const STANDARD_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><changefreq>daily</changefreq></url>
  <url><loc>https://example.com/about</loc></url>
  <url><loc>https://example.com/blog/post-1</loc></url>
  <url><loc>https://example.com/blog/post-2</loc></url>
  <url><loc>https://example.com/products/widget</loc></url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-blog.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-products.xml</loc></sitemap>
</sitemapindex>`;

const EMPTY_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;

// Inline parser — mirrors what src/sitemap.ts should do
function parseUrlsFromSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
}

function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
}

function filterByPath(urls: string[], includePath: string): string[] {
  return urls.filter((url) => {
    try {
      return new URL(url).pathname.startsWith(includePath);
    } catch {
      return false;
    }
  });
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "source"]
      .forEach((p) => u.searchParams.delete(p));
    let href = u.href;
    if (href.endsWith("/") && u.pathname !== "/") href = href.slice(0, -1);
    return href;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------

describe("sitemap XML parsing", () => {
  it("extracts all loc entries from a standard sitemap", () => {
    const urls = parseUrlsFromSitemap(STANDARD_SITEMAP);
    expect(urls).toHaveLength(5);
  });

  it("first URL is the root", () => {
    const urls = parseUrlsFromSitemap(STANDARD_SITEMAP);
    expect(urls[0]).toBe("https://example.com/");
  });

  it("last URL is the product page", () => {
    const urls = parseUrlsFromSitemap(STANDARD_SITEMAP);
    expect(urls[4]).toBe("https://example.com/products/widget");
  });

  it("returns empty array for empty sitemap", () => {
    const urls = parseUrlsFromSitemap(EMPTY_SITEMAP);
    expect(urls).toHaveLength(0);
  });

  it("returns empty array for non-xml input", () => {
    const urls = parseUrlsFromSitemap("this is not xml at all");
    expect(urls).toHaveLength(0);
  });
});

describe("sitemap index parsing", () => {
  it("extracts child sitemap URLs from sitemap index", () => {
    const sitemaps = parseSitemapIndex(SITEMAP_INDEX);
    expect(sitemaps).toHaveLength(2);
    expect(sitemaps[0]).toContain("sitemap-blog.xml");
    expect(sitemaps[1]).toContain("sitemap-products.xml");
  });
});

describe("sitemap path filtering", () => {
  it("filters to /blog/ urls only", () => {
    const urls = parseUrlsFromSitemap(STANDARD_SITEMAP);
    const filtered = filterByPath(urls, "/blog/");
    expect(filtered).toHaveLength(2);
    filtered.forEach((u) => expect(u).toContain("/blog/"));
  });

  it("filters to /products/ urls only", () => {
    const urls = parseUrlsFromSitemap(STANDARD_SITEMAP);
    const filtered = filterByPath(urls, "/products/");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toContain("widget");
  });

  it("returns all urls when include path is root /", () => {
    const urls = parseUrlsFromSitemap(STANDARD_SITEMAP);
    const filtered = filterByPath(urls, "/");
    expect(filtered).toHaveLength(5);
  });

  it("returns empty array for non-matching path", () => {
    const urls = parseUrlsFromSitemap(STANDARD_SITEMAP);
    const filtered = filterByPath(urls, "/careers/");
    expect(filtered).toHaveLength(0);
  });
});

describe("URL normalisation", () => {
  it("strips utm params", () => {
    const url = "https://blog.n8n.io/post?utm_source=twitter&utm_medium=social";
    expect(normalizeUrl(url)).toBe("https://blog.n8n.io/post");
  });

  it("strips ref and source params", () => {
    const url = "https://example.com/page?ref=homepage&source=nav";
    expect(normalizeUrl(url)).toBe("https://example.com/page");
  });

  it("strips trailing slash on non-root paths", () => {
    const url = "https://example.com/blog/";
    expect(normalizeUrl(url)).toBe("https://example.com/blog");
  });

  it("keeps trailing slash on root", () => {
    const url = "https://example.com/";
    expect(normalizeUrl(url)).toBe("https://example.com/");
  });

  it("strips hash fragments", () => {
    const url = "https://example.com/page#section-2";
    expect(normalizeUrl(url)).not.toContain("#");
  });

  it("deduplication works via Set on normalised urls", () => {
    const urls = [
      "https://example.com/page?utm_source=a",
      "https://example.com/page?utm_source=b",
      "https://example.com/page",
    ];
    const normalised = new Set(urls.map(normalizeUrl));
    expect(normalised.size).toBe(1);
  });
});
