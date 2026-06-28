/**
 * fetcher.ts — Tiered Fetch Engine (Phase 2)
 *
 * Strategy:
 *   auto (default) → try Axios first (~100ms)
 *                  → if JS-render detected OR blocked (403/429/empty), escalate to Playwright
 *
 * This cuts crawl time by 40–60% on static sites (blogs, docs, pricing pages)
 * while still handling SPAs and bot-protected pages transparently.
 *
 * Modes:
 *   fast      — Axios only, never escalates (use for known static sites)
 *   stealth   — Playwright only (use for known JS-heavy / protected sites)
 *   intercept — Playwright + XHR tap (use to steal JSON from API calls)
 *   auto      — smart tiered: Axios → Playwright fallback (RECOMMENDED)
 */

import axios from "axios";
import type { AxiosProxyConfig } from "axios";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";
import { proxyPool, classifyOutcome } from "./lib/proxy-pool";

chromium.use(StealthPlugin());

/** Build an Axios proxy config from a proxy URL. Returns false to disable. */
function axiosProxy(proxyUrl?: string): AxiosProxyConfig | false {
  if (!proxyUrl) return false;
  try {
    const u = new URL(proxyUrl);
    if (!u.protocol.startsWith("http")) return false; // socks → Playwright only
    return {
      protocol: u.protocol.replace(":", ""),
      host: u.hostname,
      port: parseInt(u.port || "80", 10),
      ...(u.username
        ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } }
        : {}),
    };
  } catch {
    return false;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];

const AXIOS_HEADERS = {
  "Accept":                  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language":         "en-US,en;q=0.9",
  "Accept-Encoding":         "gzip, deflate, br",
  "Connection":              "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

/** Resource types to block in Playwright (fonts/media waste bandwidth, never needed) */
const BLOCKED_RESOURCE_TYPES = new Set(["font", "media", "websocket"]);

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type FetchMode = "fast" | "stealth" | "intercept" | "auto";

export interface FetchOptions {
  mode?: FetchMode;
  proxy?: string;
  timeoutMs?: number;
  interceptPattern?: RegExp;
  headless?: boolean;
}

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number | null;
  mode: FetchMode;
  fetchMode: FetchMode;
  usedFallback: boolean;       // ← true when auto-mode escalated to Playwright
  interceptedJson?: unknown[];
  durationMs: number;
}

// ─── JS-render detection ──────────────────────────────────────────────────────
//
// These are the signals that indicate a page needs JavaScript to render its
// real content. If ANY signal fires, we escalate to Playwright.
//
// Signals (ordered by specificity):
//   1. Framework markers   — React root, Next.js data, Vue app, Nuxt, Angular
//   2. Empty body          — HTML shell with no meaningful text content
//   3. Loading indicators  — "Loading..." placeholders in near-empty bodies
//   4. Cloudflare / WAF    — challenge pages that need a real browser to solve
//   5. Very short response — under 2KB is almost always a shell

export interface JsRenderSignal {
  triggered: boolean;
  reason: string;
}

export function detectJSRender(html: string): JsRenderSignal {
  // 1. Framework markers
  if (/__NEXT_DATA__/.test(html))
    return { triggered: true, reason: "Next.js SSR marker detected" };

  if (/window\.__NUXT__/.test(html))
    return { triggered: true, reason: "Nuxt.js marker detected" };

  if (/ng-version=/.test(html) || /ng-app=/.test(html))
    return { triggered: true, reason: "Angular app marker detected" };

  if (/<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i.test(html))
    return { triggered: true, reason: "Empty Vue/generic app root" };

  if (/<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i.test(html))
    return { triggered: true, reason: "Empty React root div" };

  if (/window\.__INITIAL_STATE__/.test(html) || /window\.__PRELOADED_STATE__/.test(html))
    return { triggered: true, reason: "Redux/Vuex preloaded state marker" };

  // 2. Cloudflare / WAF challenge
  if (/cf-browser-verification|challenge-form|jschl-answer|cf_chl_prog/.test(html))
    return { triggered: true, reason: "Cloudflare challenge page" };

  if (/Enable JavaScript and cookies to continue/.test(html))
    return { triggered: true, reason: "JS required banner" };

  // 3. Very short body with no meaningful semantic content
  if (html.length < 2000) {
    const hasMeaningfulTag = /<(article|main|section|h1|h2|p|table|ul|ol)[^>]*>/i.test(html);
    if (!hasMeaningfulTag)
      return { triggered: true, reason: `Short response (${html.length} chars) with no semantic content` };
  }

  // 4. Loading placeholder text in body
  if (/<body[^>]*>\s*(<[^>]+>\s*)*Loading\.{0,3}\s*(<\/[^>]+>\s*)*<\/body>/i.test(html))
    return { triggered: true, reason: "Loading placeholder in body" };

  return { triggered: false, reason: "static" };
}

// ─── Fast fetch (Axios) ───────────────────────────────────────────────────────

async function fetchFast(url: string, timeoutMs: number, proxy?: string): Promise<FetchResult> {
  const start = Date.now();
  try {
    const res = await axios.get<string>(url, {
      headers: { ...AXIOS_HEADERS, "User-Agent": pick(USER_AGENTS) },
      timeout: timeoutMs,
      maxRedirects: 5,
      responseType: "text",
      proxy: axiosProxy(proxy),
    });
    return {
      html: res.data,
      finalUrl: (res.request as any)?.res?.responseUrl ?? url,
      statusCode: res.status,
      mode: "fast",
      fetchMode: "fast",
      usedFallback: false,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const e = err as { response?: { status: number; data: string } };
    if (e.response) {
      return {
        html: e.response.data ?? "",
        finalUrl: url,
        statusCode: e.response.status,
        mode: "fast",
        fetchMode: "fast",
        usedFallback: false,
        durationMs: Date.now() - start,
      };
    }
    throw err;
  }
}

// ─── Stealth fetch (Playwright) ───────────────────────────────────────────────

async function fetchStealth(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const { proxy, timeoutMs = 30_000, headless = true } = opts;
  const viewport  = pick(VIEWPORTS);
  const userAgent = pick(USER_AGENTS);

  const browser: Browser = await (chromium as any).launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      `--window-size=${viewport.width},${viewport.height}`,
    ],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });

  let statusCode: number | null = null;

  const context: BrowserContext = await browser.newContext({
    viewport,
    userAgent,
    locale: "en-US",
    timezoneId: "America/New_York",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  // Block fonts/media/websockets — saves 30-50% of page load time
  await context.route("**/*", (route) => {
    if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
      return route.abort();
    }
    return route.continue();
  });

  const page: Page = await context.newPage();

  page.on("response", (response) => {
    if (response.url().startsWith(url.split("?")[0])) {
      statusCode = response.status();
    }
  });

  await page.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, "webdriver", { get: () => false });
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(2000);
  }

  const html     = await page.content();
  const finalUrl = page.url();
  await browser.close();

  return {
    html,
    finalUrl,
    statusCode,
    mode: "stealth",
    fetchMode: "stealth",
    usedFallback: false,
    durationMs: Date.now() - start,
  };
}

// ─── Intercept fetch (steal JSON from XHR/Fetch calls) ────────────────────────

async function fetchIntercept(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start   = Date.now();
  const { proxy, timeoutMs = 30_000, headless = true } = opts;
  const pattern = opts.interceptPattern ?? /\/(api|json|data|v\d+|graphql)\//i;
  const captured: unknown[] = [];

  const browser: Browser = await (chromium as any).launch({
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });

  const context: BrowserContext = await browser.newContext({
    viewport: pick(VIEWPORTS),
    userAgent: pick(USER_AGENTS),
    locale: "en-US",
    ignoreHTTPSErrors: true,
  });

  const page: Page = await context.newPage();

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
    statusCode: 200,
    mode: "intercept",
    fetchMode: "intercept",
    usedFallback: false,
    interceptedJson: captured,
    durationMs: Date.now() - start,
  };
}

// ─── Auto fetch (tiered: Axios → Playwright fallback) ─────────────────────────
//
// Decision tree:
//   1. Try Axios (fast, ~100ms)
//   2. Check HTTP status:
//      - 403 / 429 / 503 → blocked, escalate to Playwright immediately
//   3. Run JS-render detection on the response HTML:
//      - Any signal → escalate to Playwright
//   4. If Axios threw a network error → escalate to Playwright
//   5. Otherwise → return Axios result directly (no browser needed)

async function fetchAuto(url: string, opts: FetchOptions): Promise<FetchResult> {
  const timeout = opts.timeoutMs ?? 15_000;

  // Stage 1: Axios attempt
  let axiosResult: FetchResult | null = null;
  let axiosError: unknown = null;

  try {
    axiosResult = await fetchFast(url, timeout, opts.proxy);
  } catch (err) {
    axiosError = err;
  }

  // Stage 2: Decide whether to escalate
  if (axiosResult) {
    // Blocked by WAF / rate limit
    const blocked = [403, 429, 503].includes(axiosResult.statusCode ?? 0);
    if (blocked) {
      console.log(` → HTTP ${axiosResult.statusCode} — escalating to stealth browser`);
      const stealthResult = await fetchStealth(url, opts);
      return { ...stealthResult, usedFallback: true };
    }

    // JS-render detection
    const signal = detectJSRender(axiosResult.html);
    if (signal.triggered) {
      console.log(` → JS render detected (${signal.reason}) — escalating to stealth browser`);
      const stealthResult = await fetchStealth(url, opts);
      return { ...stealthResult, usedFallback: true };
    }

    // Static page — return Axios result directly
    return axiosResult;
  }

  // Stage 3: Axios threw — escalate
  console.log(` → Axios failed (${(axiosError as Error)?.message ?? "unknown"}) — escalating to stealth browser`);
  const stealthResult = await fetchStealth(url, opts);
  return { ...stealthResult, usedFallback: true };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const mode = opts.mode ?? "auto";

  // ── Proxy rotation ──────────────────────────────────────────────────────
  // If the caller didn't pin a proxy, pull one from the rotating pool.
  // We then report the outcome so banned/slow proxies cool down automatically.
  let leasedProxy: string | null = null;
  if (!opts.proxy && proxyPool.enabled) {
    leasedProxy = proxyPool.acquire(url);
    if (leasedProxy) opts = { ...opts, proxy: leasedProxy };
  }

  const run = (): Promise<FetchResult> => {
    switch (mode) {
      case "fast":      return fetchFast(url, opts.timeoutMs ?? 15_000, opts.proxy);
      case "stealth":   return fetchStealth(url, opts);
      case "intercept": return fetchIntercept(url, opts);
      case "auto":
      default:          return fetchAuto(url, opts);
    }
  };

  if (!leasedProxy) return run();

  try {
    const result = await run();
    proxyPool.report(leasedProxy, classifyOutcome(result.statusCode, result.html), result.durationMs);
    return result;
  } catch (err) {
    proxyPool.report(leasedProxy, "error");
    throw err;
  }
}
