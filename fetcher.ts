/**
 * fetcher.ts
 * Dual-mode page fetcher.
 *
 * Mode 1 — FAST (axios + Chrome headers):
 * HTTP with realistic Chrome headers. ~50-200ms per page.
 * Use for static HTML sites that don't require JS rendering.
 *
 * Mode 2 — STEALTH (browser.ts rebrowser-patches stack):
 * Full headless browser. ~2-5s per page.
 * Use for JS-heavy / React / SPA / Cloudflare sites.
 *
 * Mode 3 — INTERCEPT (Playwright + Network tap):
 * Intercepts XHR/Fetch JSON from the page's own backend.
 * Bypasses HTML parsing entirely — fastest structured extraction.
 *
 * Auto-mode: tries FAST first, falls back to STEALTH if JS render detected.
 */

import axios from "axios";
import { chromium } from "playwright";
import { fetchPage as browserFetch } from "./browser.js";
import type { BrowserOptions } from "./browser.js";

// ─── Types ────────────────────────────────────────────────────────────────────
export type FetchMode = "fast" | "stealth" | "intercept" | "auto";

export interface FetchOptions {
  mode?: FetchMode;
  proxy?: string;
  timeoutMs?: number;
  interceptPattern?: RegExp;
  headless?: boolean;
  saveProfile?: boolean;
  profileId?: string;
}

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number | null;
  mode: FetchMode;
  interceptedJson?: unknown[];
  durationMs: number;
}

// ─── Chrome fingerprint profiles for fast path ────────────────────────────────
// Headers sent in Chrome's exact order with synced sec-ch-ua values.
// This is the same header-level detection bypass as got-scraping,
// implemented directly so we stay in CJS-land.
interface FastProfile {
  userAgent: string;
  secChUa: string;
  secChUaPlatform: string;
}

const FAST_PROFILES: FastProfile[] = [
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    secChUaPlatform: '"Windows"',
  },
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="99"',
    secChUaPlatform: '"Windows"',
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    secChUaPlatform: '"macOS"',
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="122", "Google Chrome";v="122", "Not-A.Brand";v="99"',
    secChUaPlatform: '"macOS"',
  },
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
];

const USER_AGENTS = FAST_PROFILES.map((p) => p.userAgent);

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── JS-render detection ──────────────────────────────────────────────────────
function needsJsRender(html: string): boolean {
  const hasReactRoot = /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i.test(html);
  const hasNextData  = /__NEXT_DATA__/.test(html);
  const hasVueApp    = /<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i.test(html);
  const veryShort    = html.length < 5000;
  const noContent    = !/<(article|main|section|h1|p)[^>]*>/i.test(html);
  return hasReactRoot || hasNextData || hasVueApp || (veryShort && noContent);
}

// ─── FAST fetch (axios + synced Chrome headers) ───────────────────────────────
async function fetchFast(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start   = Date.now();
  const profile = pick(FAST_PROFILES);

  // Build proxy config if provided (http/https only — axios doesn't support socks5)
  let proxyConfig: { host: string; port: number; protocol: string; auth?: { username: string; password: string } } | undefined;
  if (opts.proxy && !opts.proxy.startsWith("socks")) {
    try {
      const u = new URL(opts.proxy);
      proxyConfig = {
        host:     u.hostname,
        port:     parseInt(u.port, 10),
        protocol: u.protocol,
        ...(u.username ? { auth: { username: u.username, password: u.password } } : {}),
      };
    } catch { /* invalid proxy string — skip */ }
  }

  try {
    const res = await axios.get(url, {
      timeout: opts.timeoutMs ?? 15_000,
      maxRedirects: 5,
      responseType: "text",
      // Proxy via http(s) — socks5 not supported natively by axios
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
      // Chrome's exact header order — order matters for HTTP/2 fingerprint
      headers: {
        "sec-ch-ua":                 profile.secChUa,
        "sec-ch-ua-mobile":          "?0",
        "sec-ch-ua-platform":        profile.secChUaPlatform,
        "Upgrade-Insecure-Requests": "1",
        "User-Agent":                profile.userAgent,
        "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Sec-Fetch-Site":            "none",
        "Sec-Fetch-Mode":            "navigate",
        "Sec-Fetch-User":            "?1",
        "Sec-Fetch-Dest":            "document",
        "Accept-Encoding":           "gzip, deflate, br",
        "Accept-Language":           "en-US,en;q=0.9",
        "Connection":                "keep-alive",
      },
    });

    return {
      html:        res.data as string,
      finalUrl:    res.request?.res?.responseUrl ?? url,
      statusCode:  res.status,
      mode:        "fast",
      durationMs:  Date.now() - start,
    };
  } catch (err: unknown) {
    const e = err as { response?: { status: number; data: string } };
    if (e.response) {
      return {
        html:       e.response.data ?? "",
        finalUrl:   url,
        statusCode: e.response.status,
        mode:       "fast",
        durationMs: Date.now() - start,
      };
    }
    throw err;
  }
}

// ─── STEALTH fetch (browser.ts rebrowser-patches stack) ──────────────────────
async function fetchStealth(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();

  const browserOpts: BrowserOptions = {
    headless:    opts.headless ?? true,
    proxy:       opts.proxy,
    timeoutMs:   opts.timeoutMs,
    saveProfile: opts.saveProfile ?? true,
    profileId:   opts.profileId,
  };

  const result = await browserFetch(url, browserOpts);

  return {
    ...result,
    mode:       "stealth",
    durationMs: Date.now() - start,
  };
}

// ─── INTERCEPT fetch (steal JSON from network) ────────────────────────────────
async function fetchIntercept(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start   = Date.now();
  const { proxy, timeoutMs = 30_000, headless = true } = opts;
  const pattern = opts.interceptPattern ?? /\.(json|api|graphql|data|v\d+)/i;
  const captured: unknown[] = [];

  const browser = await chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });

  const context = await browser.newContext({
    viewport:          pick(VIEWPORTS),
    userAgent:         pick(USER_AGENTS),
    locale:            "en-US",
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  page.on("response", async (response) => {
    try {
      const respUrl     = response.url();
      const contentType = response.headers()["content-type"] ?? "";
      if (
        contentType.includes("application/json") &&
        (pattern.test(respUrl) || respUrl !== url)
      ) {
        const json = await response.json().catch(() => null);
        if (json && typeof json === "object") captured.push(json);
      }
    } catch { /* ignore */ }
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(3000);
  }

  const html     = await page.content();
  const finalUrl = page.url();
  await browser.close();

  return {
    html,
    finalUrl,
    statusCode:      200,
    mode:            "intercept",
    interceptedJson: captured,
    durationMs:      Date.now() - start,
  };
}

// ─── AUTO fetch ───────────────────────────────────────────────────────────────
async function fetchAuto(url: string, opts: FetchOptions): Promise<FetchResult> {
  try {
    const result = await fetchFast(url, opts);
    if (
      !needsJsRender(result.html) &&
      result.statusCode !== 403 &&
      result.statusCode !== 429
    ) {
      return result;
    }
    console.log(` → JS render / block detected, switching to stealth browser`);
  } catch {
    console.log(` → Fast fetch failed, switching to stealth browser`);
  }
  return fetchStealth(url, opts);
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function fetchPage(
  url: string,
  opts: FetchOptions = {}
): Promise<FetchResult> {
  const mode = opts.mode ?? "auto";
  switch (mode) {
    case "fast":      return fetchFast(url, opts);
    case "stealth":   return fetchStealth(url, opts);
    case "intercept": return fetchIntercept(url, opts);
    case "auto":
    default:          return fetchAuto(url, opts);
  }
}
