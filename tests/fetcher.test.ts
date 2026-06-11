import { describe, it, expect } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { detectJSRender } from "../src/fetcher";

// ─── Local test server helper ─────────────────────────────────────────────────

function createServer(html: string): Promise<{ url: string; close: () => void }> {
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

// ─── Static HTML fixtures (should NOT trigger JS-render detection) ────────────

const STATIC_BLOG = `<!DOCTYPE html>
<html>
<head><title>How to Build a SaaS in 2025</title></head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <main>
    <article>
      <h1>How to Build a SaaS in 2025</h1>
      <p>The SaaS landscape has changed dramatically in the past few years.</p>
      <p>In this guide, we'll walk through the key steps to launch your product.</p>
      <ul>
        <li>Validate your idea</li>
        <li>Build an MVP</li>
        <li>Find your first 10 customers</li>
      </ul>
    </article>
  </main>
  <footer>© 2025 Example Blog</footer>
</body>
</html>`;

const STATIC_PRODUCT = `<!DOCTYPE html>
<html>
<body>
  <h1 class="product-title">Widget Pro 3000</h1>
  <span class="price">₹2,499</span>
  <div class="description">The best widget for all your needs.</div>
  <span class="stock">In Stock</span>
  <div class="rating">4.5 out of 5 stars</div>
</body>
</html>`;

const STATIC_PRICING = `<!DOCTYPE html>
<html>
<body>
  <h1>Pricing Plans</h1>
  <div class="pricing-card">
    <h2>Starter</h2>
    <span class="price">$9/mo</span>
    <ul><li>5 projects</li><li>1GB storage</li></ul>
  </div>
  <div class="pricing-card">
    <h2>Pro</h2>
    <span class="price">$29/mo</span>
    <ul><li>Unlimited projects</li><li>10GB storage</li></ul>
  </div>
</body>
</html>`;

// ─── JS-heavy HTML fixtures (SHOULD trigger JS-render detection) ──────────────

const REACT_SHELL = `<!DOCTYPE html>
<html>
<head><title>My App</title></head>
<body>
  <div id="root"></div>
  <script src="/static/js/main.chunk.js"></script>
</body>
</html>`;

const NEXTJS_SHELL = `<!DOCTYPE html>
<html>
<head><title>Next App</title></head>
<body>
  <div id="__next"><div></div></div>
  <script id="__NEXT_DATA__" type="application/json">{"props":{},"page":"/"}</script>
</body>
</html>`;

const VUE_SHELL = `<!DOCTYPE html>
<html>
<body>
  <div id="app"></div>
  <script src="/js/app.js"></script>
</body>
</html>`;

const NUXT_SHELL = `<!DOCTYPE html>
<html>
<body>
  <div id="__nuxt"></div>
  <script>window.__NUXT__={config:{},data:{}}</script>
</body>
</html>`;

const ANGULAR_SHELL = `<!DOCTYPE html>
<html>
<body>
  <app-root ng-version="15.0.0"></app-root>
</body>
</html>`;

const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html>
<html>
<body>
  <div id="cf-browser-verification">
    <form id="challenge-form" action="/cdn-cgi/challenge-platform">
      <input name="jschl-answer" type="hidden">
    </form>
  </div>
</body>
</html>`;

const JS_REQUIRED_BANNER = `<!DOCTYPE html>
<html>
<body>
  <noscript>
    <p>Enable JavaScript and cookies to continue</p>
  </noscript>
</body>
</html>`;

const LOADING_PLACEHOLDER = `<!DOCTYPE html>
<html>
<body>
  <div>Loading...</div>
</body>
</html>`;

// ─── detectJSRender unit tests ────────────────────────────────────────────────

describe("detectJSRender — static pages (should NOT trigger)", () => {
  it("does not flag a static blog post", () => {
    const result = detectJSRender(STATIC_BLOG);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("static");
  });

  it("does not flag a static product page", () => {
    const result = detectJSRender(STATIC_PRODUCT);
    expect(result.triggered).toBe(false);
  });

  it("does not flag a static pricing page", () => {
    const result = detectJSRender(STATIC_PRICING);
    expect(result.triggered).toBe(false);
  });

  it("does not flag a normal HTML page with a script tag present", () => {
    const html = `<html><body>
      <h1>Normal Page</h1>
      <p>Some content here that is meaningful and substantial.</p>
      <script>console.log('analytics')</script>
    </body></html>`;
    const result = detectJSRender(html);
    expect(result.triggered).toBe(false);
  });

  it("does not flag a page with a non-empty root div", () => {
    const html = `<html><body>
      <div id="root">
        <h1>Already rendered server-side</h1>
        <p>This content is real and already in the HTML.</p>
      </div>
    </body></html>`;
    const result = detectJSRender(html);
    expect(result.triggered).toBe(false);
  });
});

describe("detectJSRender — JS-heavy pages (SHOULD trigger)", () => {
  it("flags an empty React root div", () => {
    const result = detectJSRender(REACT_SHELL);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("React");
  });

  it("flags a Next.js page with __NEXT_DATA__", () => {
    const result = detectJSRender(NEXTJS_SHELL);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("Next.js");
  });

  it("flags an empty Vue app div", () => {
    const result = detectJSRender(VUE_SHELL);
    expect(result.triggered).toBe(true);
  });

  it("flags a Nuxt.js page", () => {
    const result = detectJSRender(NUXT_SHELL);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("Nuxt");
  });

  it("flags an Angular app", () => {
    const result = detectJSRender(ANGULAR_SHELL);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("Angular");
  });

  it("flags a Cloudflare challenge page", () => {
    const result = detectJSRender(CLOUDFLARE_CHALLENGE);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("Cloudflare");
  });

  it("flags a JS-required banner page", () => {
    const result = detectJSRender(JS_REQUIRED_BANNER);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("JS required");
  });

  it("flags a Loading... placeholder page", () => {
    const result = detectJSRender(LOADING_PLACEHOLDER);
    expect(result.triggered).toBe(true);
  });

  it("flags a very short page with no semantic tags", () => {
    const html = "<html><body><div>hi</div></body></html>";
    const result = detectJSRender(html);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("Short response");
  });
});

describe("detectJSRender — return shape", () => {
  it("always returns triggered and reason fields", () => {
    const result = detectJSRender(STATIC_BLOG);
    expect(result).toHaveProperty("triggered");
    expect(result).toHaveProperty("reason");
    expect(typeof result.triggered).toBe("boolean");
    expect(typeof result.reason).toBe("string");
  });

  it("reason is 'static' when not triggered", () => {
    expect(detectJSRender(STATIC_BLOG).reason).toBe("static");
    expect(detectJSRender(STATIC_PRODUCT).reason).toBe("static");
  });

  it("reason is descriptive when triggered", () => {
    const result = detectJSRender(NEXTJS_SHELL);
    expect(result.reason.length).toBeGreaterThan(5);
    expect(result.reason).not.toBe("static");
  });

  it("handles empty string without throwing", () => {
    expect(() => detectJSRender("")).not.toThrow();
  });

  it("handles malformed HTML without throwing", () => {
    expect(() => detectJSRender("<<<not html>>>")).not.toThrow();
  });
});

describe("detectJSRender — edge cases", () => {
  it("does not flag a page that has id=root with content inside", () => {
    const html = `<html><body>
      <div id="root">
        <main>
          <h1>Server rendered content</h1>
          <p>This is a full paragraph of real content from SSR.</p>
        </main>
      </div>
    </body></html>`;
    // root div is NOT empty — should not trigger
    const result = detectJSRender(html);
    expect(result.triggered).toBe(false);
  });

  it("flags redux preloaded state marker", () => {
    const html = `<html><body>
      <div id="root"><div></div></div>
      <script>window.__PRELOADED_STATE__ = {}</script>
    </body></html>`;
    const result = detectJSRender(html);
    expect(result.triggered).toBe(true);
  });

  it("prioritises framework detection over length check", () => {
    // Next.js page that happens to be short
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>`;
    const result = detectJSRender(html);
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("Next.js");
  });
});

describe("fetchPage — fast mode via local server", () => {
  it("fetches HTML from a local static server", async () => {
    const { url, close } = await createServer(STATIC_BLOG);
    try {
      // Import here so tests that don't need it don't pay the import cost
      const { fetchPage } = await import("../src/fetcher");
      const result = await fetchPage(url, { mode: "fast", timeoutMs: 5000 });
      expect(result.html).toContain("How to Build a SaaS");
      expect(result.statusCode).toBe(200);
      expect(result.mode).toBe("fast");
      expect(result.usedFallback).toBe(false);
      expect(result.durationMs).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("returns finalUrl and durationMs", async () => {
    const { url, close } = await createServer(STATIC_PRODUCT);
    try {
      const { fetchPage } = await import("../src/fetcher");
      const result = await fetchPage(url, { mode: "fast", timeoutMs: 5000 });
      expect(result.finalUrl).toBeTruthy();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      close();
    }
  });
});
