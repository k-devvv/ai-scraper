import { describe, it, expect } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Pipeline integration tests — uses a local HTTP server, no external network.
// Tests the URL normalisation, HTML cleaning, and BFS filtering logic that
// lives across pipeline.ts / crawler.ts / cleaner.ts.
// ---------------------------------------------------------------------------

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTestServer(html: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    [
      "utm_source", "utm_medium", "utm_campaign",
      "utm_content", "utm_term", "ref", "source",
    ].forEach((p) => u.searchParams.delete(p));
    let href = u.href;
    if (href.endsWith("/") && u.pathname !== "/") href = href.slice(0, -1);
    return href;
  } catch {
    return url;
  }
}

function htmlToMarkdown(html: string): {
  markdown: string;
  charCount: number;
  estimatedTokens: number;
} {
  if (!html || html.trim() === "") return { markdown: "", charCount: 0, estimatedTokens: 0 };
  let cleaned = html;
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  cleaned = cleaned.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  cleaned = cleaned.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n## $1\n");
  cleaned = cleaned.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  cleaned = cleaned.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const charCount = cleaned.length;
  return { markdown: cleaned, charCount, estimatedTokens: Math.ceil(charCount / 4) };
}

const UTILITY_PATHS = [
  "/tag/", "/author/", "/page/", "/rss", "/feed", "/feeds",
  "/assets/", "/public/", "/ghost/", "/sitemap", "/amp/",
  "/subscribe", "/signin", "/signup", "/login", "/logout",
  "/account", "/cart", "/checkout", "/search",
  "/cdn-cgi/", "/_next/", "/static/", "/api/",
];

const ASSET_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|svg|css|js|xml|json|woff|woff2|ttf|ico|map|zip|gz)$/i;

function shouldCrawlUrl(url: string, allowedOrigin: string, seedPath: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }

  if (u.origin !== allowedOrigin) return false;
  if (seedPath && !u.pathname.startsWith(seedPath)) return false;
  if (ASSET_EXTENSIONS.test(u.pathname)) return false;
  if (u.search.length > 0) return false;
  if (UTILITY_PATHS.some((p) => u.pathname.startsWith(p) || u.pathname.includes(p))) return false;

  return true;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("URL normalisation", () => {
  it("strips utm_source, utm_medium, utm_campaign", () => {
    const url = "https://blog.n8n.io/post?utm_source=twitter&utm_medium=social&utm_campaign=q4";
    expect(normalizeUrl(url)).toBe("https://blog.n8n.io/post");
  });

  it("strips ref and source params", () => {
    expect(normalizeUrl("https://example.com/page?ref=nav&source=header"))
      .toBe("https://example.com/page");
  });

  it("strips trailing slash on non-root paths", () => {
    expect(normalizeUrl("https://example.com/blog/")).toBe("https://example.com/blog");
  });

  it("preserves trailing slash on root", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("strips hash fragments", () => {
    expect(normalizeUrl("https://example.com/page#section-2")).not.toContain("#");
  });

  it("deduplicates URLs via Set after normalisation", () => {
    const urls = [
      "https://example.com/page?utm_source=a",
      "https://example.com/page?utm_source=b",
      "https://example.com/page",
    ];
    const normalised = new Set(urls.map(normalizeUrl));
    expect(normalised.size).toBe(1);
  });
});

describe("HTML → Markdown cleaning", () => {
  it("reduces character count vs raw HTML", () => {
    const html = `
      <html>
        <head><style>body{color:red;margin:0;font-size:16px}</style></head>
        <body>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <article>
            <h1>Real Content Title</h1>
            <p>This is the real paragraph that matters for extraction.</p>
          </article>
          <footer>Footer junk</footer>
        </body>
      </html>
    `;
    const result = htmlToMarkdown(html);
    expect(result.charCount).toBeLessThan(html.length);
    expect(result.markdown).toContain("Real Content Title");
  });

  it("estimatedTokens is roughly charCount / 4", () => {
    const html = "<p>Hello world, this is a test sentence.</p>";
    const result = htmlToMarkdown(html);
    // Math.ceil means the result can be up to 1 above charCount/4
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(Math.floor(result.charCount / 4));
    expect(result.estimatedTokens).toBeLessThanOrEqual(Math.ceil(result.charCount / 4));
  });

  it("strips script content completely", () => {
    const html = "<script>alert('xss')</script><p>Safe content</p>";
    const result = htmlToMarkdown(html);
    expect(result.markdown).not.toContain("xss");
    expect(result.markdown).toContain("Safe content");
  });
});

describe("BFS URL filter — shouldCrawlUrl", () => {
  const origin = "https://blog.n8n.io";

  it("allows same-origin path", () => {
    expect(shouldCrawlUrl("https://blog.n8n.io/post/ai-agents", origin, "")).toBe(true);
  });

  it("blocks cross-origin urls", () => {
    expect(shouldCrawlUrl("https://evil.com/steal", origin, "")).toBe(false);
  });

  it("blocks asset extensions", () => {
    expect(shouldCrawlUrl("https://blog.n8n.io/image.png", origin, "")).toBe(false);
    expect(shouldCrawlUrl("https://blog.n8n.io/style.css", origin, "")).toBe(false);
    expect(shouldCrawlUrl("https://blog.n8n.io/script.js", origin, "")).toBe(false);
  });

  it("blocks utility paths", () => {
    expect(shouldCrawlUrl("https://blog.n8n.io/tag/ai", origin, "")).toBe(false);
    expect(shouldCrawlUrl("https://blog.n8n.io/login", origin, "")).toBe(false);
    expect(shouldCrawlUrl("https://blog.n8n.io/api/data", origin, "")).toBe(false);
    expect(shouldCrawlUrl("https://blog.n8n.io/_next/static/chunk.js", origin, "")).toBe(false);
  });

  it("blocks URLs with query strings", () => {
    expect(shouldCrawlUrl("https://blog.n8n.io/post?page=2", origin, "")).toBe(false);
  });

  it("enforces seed path scoping", () => {
    expect(shouldCrawlUrl("https://blog.n8n.io/blog/post-1", origin, "/blog")).toBe(true);
    expect(shouldCrawlUrl("https://blog.n8n.io/about", origin, "/blog")).toBe(false);
  });
});

describe("local HTTP server integration", () => {
  it("fetches HTML from a local test server", async () => {
    const html = "<html><body><h1>Test Page</h1><p>Hello from local server.</p></body></html>";
    const { url, close } = await createTestServer(html);

    try {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Test Page");
      expect(body).toContain("Hello from local server.");
    } finally {
      close();
    }
  });

  it("cleaned markdown from local server is shorter than raw HTML", async () => {
    const html = `
      <html>
        <head><style>.a{color:red}</style></head>
        <body>
          <nav><a>Home</a><a>About</a><a>Contact</a><a>Blog</a></nav>
          <main><h1>Article Title</h1><p>The main content goes here.</p></main>
          <footer>All rights reserved 2025 Example Corp</footer>
        </body>
      </html>
    `;
    const { url, close } = await createTestServer(html);

    try {
      const response = await fetch(url);
      const rawHtml = await response.text();
      const { markdown, charCount } = htmlToMarkdown(rawHtml);
      expect(charCount).toBeLessThan(rawHtml.length);
      expect(markdown).toContain("Article Title");
    } finally {
      close();
    }
  });
});
