/**
 * fetcher.ts — Tiered Fetch Engine (Phase 3)
 *
 * Tier 1 — got-scraping (TLS fingerprint spoof, impersonates Chrome 120+)
 * Tier 2 — Playwright stealth browser (JS-heavy / bot-protected pages)
 * Tier 3 — Playwright + XHR intercept (steal JSON from API calls)
 *
 * Modes:
 *   fast      — got-scraping only, never escalates
 *   stealth   — Playwright only
 *   intercept — Playwright + XHR tap
 *   auto      — got-scraping → Playwright fallback (RECOMMENDED)
 *
 * Proxy support:
 *   Any http/https/socks5 URL — e.g. "socks5://127.0.0.1:9050" for Tor
 */

import { gotScraping } from "got-scraping";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

chromium.use(StealthPlugin());

// ── Constants ─────────────────────────────────────────────────────────────────

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
];

const CHROME_VERSIONS = [120, 121, 122, 123, 124, 125];

const BLOCKED_RESOURCE_TYPES = new Set(["font", "media", "websocket"]);

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomChromeVersion(): number {
  return pick(CHROME_VERSIONS);
}

// ── Types ─────────────────────────────────────────────────────────────────────

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
  usedFallback: boolean;
  interceptedJson?: unknown[];
  durationMs: number;
}

// ── JS-render detection ───────────────────────────────────────────────────────

export interface JsRenderSignal {
  triggered: boolean;
  reason: string;
}

export function detectJSRender(html: string): JsRenderSignal {
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
  if (/cf-browser-verification|challenge-form|jschl-answer|cf_chl_prog/.test(html))
    return { triggered: true, reason: "Cloudflare challenge page" };
  if (/Enable JavaScript and cookies to continue/.test(html))
    return { triggered: true, reason: "JS required banner" };
  if (/datadome/.test(html.toLowerCase()))
    return { triggered: true, reason: "DataDome bot protection detected" };
  if (/perimeterx|px-captcha/.test(html.toLowerCase()))
    return { triggered: true, reason: "PerimeterX bot protection detected" };
  if (html.length < 2000) {
    const hasMeaningfulTag = /<(article|main|section|h1|h2|p|table|ul|ol)[^>]*>/i.test(html);
    if (!hasMeaningfulTag)
      return { triggered: true, reason: `Short response (${html.length} chars) with no semantic content` };
  }
  if (/<body[^>]*>\s*(<[^>]+>\s*)*Loading\.{0,3}\s*(<\/[^>]+>\s*)*<\/body>/i.test(html))
    return { triggered: true, reason: "Loading placeholder in body" };
  return { triggered: false, reason: "static" };
}

// ── Proxy agent builder ───────────────────────────────────────────────────────

function buildProxyAgent(proxy: string): HttpsProxyAgent<string> | SocksProxyAgent {
  if (proxy.startsWith("socks4") || proxy.startsWith("socks5")) {
    return new SocksProxyAgent(proxy);
  }
  return new HttpsProxyAgent(proxy);
}

// ── Tier 1: got-scraping (TLS fingerprint spoof) ──────────────────────────────
//
// got-scraping impersonates Chrome's exact TLS ClientHello:
//   - Cipher suite order matches Chrome 120+
//   - ALPN extensions (h2, http/1.1)
//   - Real Chrome Accept-Language, Accept-Encoding headers
//   - Randomised minor version for each request
//
// This bypasses TLS fingerprint checks (JA3/JA4 matching) that block
// Node.js's default TLS stack. Works against Cloudflare basic + most WAFs.

async function fetchFast(
  url: string,
  timeoutMs: number,
  proxy?: string
): Promise<FetchResult> {
  const start = Date.now();
  const chromeVersion = randomChromeVersion();

  try {
    const res = await gotScraping({
      url,
      headerGeneratorOptions: {
        browsers: [{ name: "chrome", minVersion: chromeVersion }],
        devices: ["desktop"],
        locales: ["en-US", "en"],
        operatingSystems: ["windows", "macos", "linux"],
      },
      ...(proxy
        ? {
            agent: {
              http: buildProxyAgent(proxy) as any,
              https: buildProxyAgent(proxy) as any,
            },
          }
        : {}),
      timeout: { request: timeoutMs },
      followRedirect: true,
      maxRedirects: 5,
      throwHttpErrors: false,
    });

    return {
      html: res.body,
      finalUrl: res.url,
      statusCode: res.statusCode,
      mode: "fast",
      fetchMode: "fast",
      usedFallback: false,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    throw err;
  }
}

// ── Tier 2: Playwright stealth ────────────────────────────────────────────────

async function fetchStealth(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const { proxy, timeoutMs = 30_000, headless = true } = opts;
  const viewport = pick(VIEWPORTS);
  const chromeVersion = randomChromeVersion();

  const browser: Browser = await (chromium as any).launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      `--window-size=${viewport.width},${viewport.height}`,
    ],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });

  let statusCode: number | null = null;

  const context: BrowserContext = await browser.newContext({
    viewport,
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
    locale: "en-US",
    timezoneId: "America/New_York",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua": `"Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}", "Not_A Brand";v="24"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  });

  await context.route("**/*", (route) => {
    if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
      return route.abort();
    }
    return route.continue();
  });

  const page: Page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, "webdriver", { get: () => false });
    Object.defineProperty((globalThis as any).navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty((globalThis as any).navigator, "languages", {
      get: () => ["en-US", "en"],
    });
    (globalThis as any).chrome = { runtime: {} };
  });

  page.on("response", (response) => {
    if (response.url().startsWith(url.split("?")[0])) {
      statusCode = response.status();
    }
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(2000);
  }

  const html = await page.content();
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

// ── Tier 3: XHR intercept ────────────────────────────────────────────────────

async function fetchIntercept(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
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
    locale: "en-US",
    ignoreHTTPSErrors: true,
  });

  const page: Page = await context.newPage();

  page.on("response", async (response) => {
    try {
      const respUrl = response.url();
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

  const html = await page.content();
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

// ── Auto: got-scraping → Playwright fallback ──────────────────────────────────

async function fetchAuto(url: string, opts: FetchOptions): Promise<FetchResult> {
  const timeout = opts.timeoutMs ?? 15_000;

  let fastResult: FetchResult | null = null;
  let fastError: unknown = null;

  try {
    fastResult = await fetchFast(url, timeout, opts.proxy);
  } catch (err) {
    fastError = err;
  }

  if (fastResult) {
    const blocked = [403, 429, 503].includes(fastResult.statusCode ?? 0);
    if (blocked) {
      console.log(` → HTTP ${fastResult.statusCode} — escalating to stealth browser`);
      const stealthResult = await fetchStealth(url, opts);
      return { ...stealthResult, usedFallback: true };
    }

    const signal = detectJSRender(fastResult.html);
    if (signal.triggered) {
      console.log(` → JS render detected (${signal.reason}) — escalating to stealth browser`);
      const stealthResult = await fetchStealth(url, opts);
      return { ...stealthResult, usedFallback: true };
    }

    return fastResult;
  }

  console.log(` → got-scraping failed (${(fastError as Error)?.message ?? "unknown"}) — escalating to stealth browser`);
  const stealthResult = await fetchStealth(url, opts);
  return { ...stealthResult, usedFallback: true };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const mode = opts.mode ?? "auto";
  switch (mode) {
    case "fast":      return fetchFast(url, opts.timeoutMs ?? 15_000, opts.proxy);
    case "stealth":   return fetchStealth(url, opts);
    case "intercept": return fetchIntercept(url, opts);
    case "auto":
    default:          return fetchAuto(url, opts);
  }
}
