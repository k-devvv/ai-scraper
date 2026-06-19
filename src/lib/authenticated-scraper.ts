/**
 * src/lib/authenticated-scraper.ts
 * Scrape authenticated pages by injecting saved browser cookies into Playwright.
 *
 * Supports: LinkedIn, Instagram, Facebook, Twitter/X
 *
 * Critical anti-detection measures:
 *   - Uses the exact same User-Agent that created the session
 *   - Respects per-platform rate limits (LinkedIn: 1 req / 8 seconds)
 *   - Randomised delays between actions
 *   - Scrolls like a human before extracting
 *   - Detects login walls / session expiry and marks session unhealthy
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import {
  getSession,
  markUsed,
  markUnhealthy,
  toPlaywrightCookies,
  PLATFORM_CONFIGS,
  type SessionRecord,
} from "./session-store";

chromium.use(StealthPlugin());

// ── Rate limiter per platform ─────────────────────────────────────────────────

const lastRequestTime = new Map<string, number>();

async function enforceRateLimit(platform: string): Promise<void> {
  const config = PLATFORM_CONFIGS[platform];
  if (!config) return;

  const delay = config.delayBetweenRequestsMs;
  const last = lastRequestTime.get(platform) ?? 0;
  const elapsed = Date.now() - last;

  if (elapsed < delay) {
    const wait = delay - elapsed + Math.floor(Math.random() * 1000); // add jitter
    console.log(`[auth-scraper] Rate limit: waiting ${wait}ms for ${platform}`);
    await new Promise((r) => setTimeout(r, wait));
  }

  lastRequestTime.set(platform, Date.now());
}

// ── Login detection ───────────────────────────────────────────────────────────

function isLoginPage(url: string, html: string, platform: string): boolean {
  const urlLower = url.toLowerCase();
  const htmlLower = html.toLowerCase();

  switch (platform) {
    case "linkedin":
      return (
        urlLower.includes("/login") ||
        urlLower.includes("/authwall") ||
        urlLower.includes("signin") ||
        htmlLower.includes("join now") ||
        htmlLower.includes("sign in to linkedin")
      );
    case "instagram":
      return (
        urlLower.includes("/accounts/login") ||
        htmlLower.includes("log in to instagram") ||
        htmlLower.includes('"LoginPage"')
      );
    case "facebook":
      return (
        urlLower.includes("/login") ||
        htmlLower.includes("log in to facebook") ||
        htmlLower.includes("create new account")
      );
    case "twitter":
      return (
        urlLower.includes("/login") ||
        urlLower.includes("/i/flow/login") ||
        htmlLower.includes("log in to x") ||
        htmlLower.includes("log in to twitter")
      );
    default:
      return urlLower.includes("/login") || urlLower.includes("/signin");
  }
}

// ── Human-like scrolling ──────────────────────────────────────────────────────

async function humanScroll(page: import("playwright").Page): Promise<void> {
  const scrollSteps = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < scrollSteps; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, 300 + Math.floor(Math.random() * 400));
    });
    await page.waitForTimeout(500 + Math.floor(Math.random() * 1000));
  }
}

// ── Main scraper ──────────────────────────────────────────────────────────────

export interface AuthScrapeResult {
  url: string;
  html: string;
  finalUrl: string;
  platform: string;
  sessionId: string;
  authenticated: boolean;
  loginDetected: boolean;
  durationMs: number;
}

export async function scrapeAuthenticated(
  url: string,
  platform: string,
  opts?: { proxy?: string; scroll?: boolean }
): Promise<AuthScrapeResult> {
  const start = Date.now();

  // Get a valid session
  const session = getSession(platform);
  if (!session) {
    throw new Error(
      `No healthy session for ${platform}. Import one via POST /v1/sessions/import`
    );
  }

  // Enforce rate limiting
  await enforceRateLimit(platform);

  const config = PLATFORM_CONFIGS[platform];
  const browser = await (chromium as any).launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    ...(opts?.proxy ? { proxy: { server: opts.proxy } } : {}),
  });

  try {
    const context = await browser.newContext({
      viewport: session.viewport,
      userAgent: session.userAgent,
      locale: "en-US",
      timezoneId: "America/New_York",
      ignoreHTTPSErrors: true,
    });

    // Inject cookies
    const cookies = toPlaywrightCookies(session);
    await context.addCookies(cookies);

    const page = await context.newPage();

    // Anti-detection scripts
    await page.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, "webdriver", { get: () => false });
      Object.defineProperty((globalThis as any).navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      (globalThis as any).chrome = { runtime: {} };
    });

    // Navigate
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    } catch {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(3000);
    }

    const finalUrl = page.url();
    const html = await page.content();

    // Check if we got redirected to a login page
    const loginDetected = isLoginPage(finalUrl, html, platform);

    if (loginDetected) {
      markUnhealthy(platform, session.id, "Redirected to login — session expired");
      await browser.close();
      return {
        url,
        html,
        finalUrl,
        platform,
        sessionId: session.id,
        authenticated: false,
        loginDetected: true,
        durationMs: Date.now() - start,
      };
    }

    // Scroll like a human to load lazy content
    if (opts?.scroll !== false) {
      await humanScroll(page);
      // Get content after scroll
      const scrolledHtml = await page.content();

      markUsed(platform, session.id);
      await browser.close();

      return {
        url,
        html: scrolledHtml,
        finalUrl,
        platform,
        sessionId: session.id,
        authenticated: true,
        loginDetected: false,
        durationMs: Date.now() - start,
      };
    }

    markUsed(platform, session.id);
    await browser.close();

    return {
      url,
      html,
      finalUrl,
      platform,
      sessionId: session.id,
      authenticated: true,
      loginDetected: false,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}
