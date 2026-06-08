/**
 * fetcher.ts
 * Dual-mode page fetcher: fast (Axios) or stealth (Playwright).
 *
 * EXPERT FIX: needsJsRender() was too aggressive — Next.js sites like Zapier
 * have __NEXT_DATA__ in their HTML but still serve fully rendered static HTML.
 * The old heuristic switched to 30s stealth for every Zapier page.
 *
 * New rule: only use stealth if the HTML has NO meaningful text content,
 * regardless of framework markers. A 612k HTML file with article text
 * does NOT need a browser — Cheerio reads it fine.
 */

import axios from "axios";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";

chromium.use(StealthPlugin());

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];

const AXIOS_HEADERS = {
  "User-Agent": USER_AGENTS[0],
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

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
  fetchMode?: string;
  interceptedJson?: unknown[];
  durationMs: number;
}

// ─── JS-render detection — CONSERVATIVE ──────────────────────────────────────
// Only trigger stealth when the page is genuinely empty (SPA shell).
// Do NOT trigger on Next.js/Nuxt/Gatsby markers — they server-side render.
// Rule: if the page has actual paragraph/heading text, it's renderable by Cheerio.
function needsJsRender(html: string): boolean {
  // Definitive empty SPA: root div with nothing inside
  const emptyReactRoot = /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i.test(html);
  const emptyVueApp = /<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i.test(html);

  // Very short AND no meaningful content tags
  const veryShort = html.length < 3000;
  const noContent = !/<(p|h1|h2|h3|article|main|section)[^>]*>[^<]{20,}/i.test(html);

  // Only trigger if BOTH short and no content
  return emptyReactRoot || emptyVueApp || (veryShort && noContent);
}

// ─── Fast fetch (Axios) ───────────────────────────────────────────────────────
async function fetchFast(url: string, timeoutMs: number): Promise<FetchResult> {
  const start = Date.now();
  try {
    const res = await axios.get(url, {
      headers: { ...AXIOS_HEADERS, "User-Agent": pick(USER_AGENTS) },
      timeout: timeoutMs,
      maxRedirects: 5,
      responseType: "text",
    });
    return {
      html: res.data as string,
      finalUrl: res.request?.res?.responseUrl ?? url,
      statusCode: res.status,
      fetchMode: "fast",
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const e = err as { response?: { status: number; data: string }; message: string };
    if (e.response) {
      return {
        html: e.response.data ?? "",
        finalUrl: url,
        statusCode: e.response.status,
        fetchMode: "fast",
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
  const viewport = pick(VIEWPORTS);
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

  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["font", "media", "websocket"].includes(type)) return route.abort();
    return route.continue();
  });

  const page: Page = await context.newPage();
  page.on("response", (response) => {
    if (response.url().startsWith(url.split("?")[0])) statusCode = response.status();
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

  const html = await page.content();
  const finalUrl = page.url();
  await browser.close();

  return { html, finalUrl, statusCode, fetchMode: "stealth", durationMs: Date.now() - start };
}

// ─── Intercept fetch (capture API JSON from network) ─────────────────────────
async function fetchIntercept(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const { proxy, timeoutMs = 30_000, headless = true } = opts;
  const pattern = opts.interceptPattern ?? /\.(json|api|graphql|data|v\d+)/i;
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
      const respUrl = response.url();
      const ct = response.headers()["content-type"] ?? "";
      if (ct.includes("application/json") && (pattern.test(respUrl) || respUrl !== url)) {
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

  return { html, finalUrl, statusCode: 200, fetchMode: "intercept", interceptedJson: captured, durationMs: Date.now() - start };
}

// ─── Auto mode: fast first, stealth only if truly needed ─────────────────────
async function fetchAuto(url: string, opts: FetchOptions): Promise<FetchResult> {
  try {
    const result = await fetchFast(url, opts.timeoutMs ?? 15_000);

    // Only fallback to stealth if page is genuinely empty
    if (!needsJsRender(result.html) && result.statusCode !== 403 && result.statusCode !== 429) {
      return result;
    }

    console.log(`      → JS render detected, switching to stealth browser`);
  } catch {
    console.log(`      → Axios failed, switching to stealth browser`);
  }

  return fetchStealth(url, opts);
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const mode = opts.mode ?? "auto";
  switch (mode) {
    case "fast":      return fetchFast(url, opts.timeoutMs ?? 15_000);
    case "stealth":   return fetchStealth(url, opts);
    case "intercept": return fetchIntercept(url, opts);
    case "auto":
    default:          return fetchAuto(url, opts);
  }
}
