/**
 * tests/stealth.test.ts
 * Tests for Phase 3a/3b: TLS fingerprint spoof and proxy pool.
 *
 * Note: These tests mock network calls — no real HTTP requests made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectJSRender } from "../src/fetcher";
import { ProxyPool } from "../src/lib/proxy-pool";

// ── JS render detection ───────────────────────────────────────────────────────

describe("detectJSRender", () => {
  it("detects Next.js", () => {
    const result = detectJSRender('<script id="__NEXT_DATA__"></script>');
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("Next.js");
  });

  it("detects Nuxt.js", () => {
    const result = detectJSRender("<script>window.__NUXT__ = {}</script>");
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("Nuxt");
  });

  it("detects empty React root", () => {
    const result = detectJSRender('<div id="root"></div>');
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("React");
  });

  it("detects Cloudflare challenge", () => {
    const result = detectJSRender(
      '<form id="challenge-form"><input name="jschl-answer"/></form>'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("Cloudflare");
  });

  it("detects DataDome", () => {
    const result = detectJSRender(
      "<html><body>Protected by datadome bot protection</body></html>"
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("DataDome");
  });

  it("detects PerimeterX", () => {
    const result = detectJSRender(
      '<html><body><div class="px-captcha"></div></body></html>'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("PerimeterX");
  });

  it("detects short body with no semantic content", () => {
    const result = detectJSRender("<html><body><div>Loading</div></body></html>");
    expect(result.triggered).toBe(true);
  });

  it("passes static HTML", () => {
    const result = detectJSRender(
      "<html><body><article><h1>Title</h1><p>Content here with plenty of text to be over 2000 chars " +
        "a".repeat(2100) +
        "</p></article></body></html>"
    );
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("static");
  });
});

// ── Proxy pool ────────────────────────────────────────────────────────────────

describe("ProxyPool", () => {
  beforeEach(() => {
    // Reset singleton for each test
    (ProxyPool as any).instance = null;
    // Disable Tor for unit tests
    process.env.USE_TOR = "false";
    process.env.PROXY_LIST = "";
  });

  it("starts empty", async () => {
    const pool = ProxyPool.getInstance();
    const status = pool.getStatus();
    expect(status.total).toBe(0);
    expect(status.healthy).toBe(0);
  });

  it("adds and returns a proxy", async () => {
    const pool = ProxyPool.getInstance();
    pool.addProxy("http://proxy.example.com:8080");

    const status = pool.getStatus();
    expect(status.total).toBe(1);
    expect(status.healthy).toBe(1);

    const next = await pool.next();
    expect(next).toBe("http://proxy.example.com:8080");
  });

  it("does not add duplicate proxies", () => {
    const pool = ProxyPool.getInstance();
    pool.addProxy("http://proxy.example.com:8080");
    pool.addProxy("http://proxy.example.com:8080");
    expect(pool.getStatus().total).toBe(1);
  });

  it("marks proxy as failed and removes from rotation after max failures", async () => {
    const pool = ProxyPool.getInstance();
    pool.addProxy("http://bad-proxy.com:8080");

    // Fail 3 times
    pool.markFailed("http://bad-proxy.com:8080");
    pool.markFailed("http://bad-proxy.com:8080");
    pool.markFailed("http://bad-proxy.com:8080");

    const status = pool.getStatus();
    expect(status.healthy).toBe(0);

    // Should return null (no Tor, no healthy proxies)
    const next = await pool.next();
    expect(next).toBeNull();
  });

  it("removes a proxy", async () => {
    const pool = ProxyPool.getInstance();
    pool.addProxy("http://proxy.example.com:8080");
    pool.removeProxy("http://proxy.example.com:8080");
    expect(pool.getStatus().total).toBe(0);
  });

  it("masks passwords in status", () => {
    const pool = ProxyPool.getInstance();
    pool.addProxy("http://user:secretpassword@proxy.example.com:8080");
    const status = pool.getStatus();
    expect(status.proxies[0].url).not.toContain("secretpassword");
    expect(status.proxies[0].url).toContain("***");
  });

  it("round-robins between multiple proxies", async () => {
    const pool = ProxyPool.getInstance();
    pool.addProxy("http://proxy1.example.com:8080");
    pool.addProxy("http://proxy2.example.com:8080");

    const first = await pool.next();
    const second = await pool.next();
    expect(first).not.toBe(second);
  });

  it("loads proxies from PROXY_LIST env", () => {
    process.env.PROXY_LIST = "http://p1.com:8080,socks5://p2.com:1080";
    (ProxyPool as any).instance = null;
    const pool = ProxyPool.getInstance();
    expect(pool.getStatus().total).toBe(2);
  });
});
