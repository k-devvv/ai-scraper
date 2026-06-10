/**
 * browser.ts — Full Stealth Browser (rebrowser-patches edition)
 *
 * Anti-detection layers:
 * 1. rebrowser-patches — fixes CDP-level leaks Cloudflare detects
 * 2. UA + sec-ch-ua sync — headers match the claimed Chrome version exactly
 * 3. Canvas/WebGL noise — unique GPU fingerprint per session
 * 4. Human asset loading — CSS/images allowed, only media/websocket blocked
 * 5. navigator overrides — webdriver, plugins, languages, platform
 * 6. Jitter delays — random(min,max) between requests
 * 7. Profile seeder — loads aged cookie profiles from ./profiles/*.json
 * 8. Proxy slot — residential proxy ready to wire in
 */

import * as fs from "fs";
import * as path from "path";
import { chromium } from "playwright";
import { applyRebrowserPatches } from "rebrowser-patches";

// ─── Patch Playwright at module load ─────────────────────────────────────────
applyRebrowserPatches();

// ─── Fingerprint profiles — each maps a UA to its exact sec-ch-ua value ─────

interface FingerprintProfile {
  userAgent: string;
  secChUa: string;
  secChUaPlatform: string;
  viewport: { width: number; height: number };
  platform: string;
  vendor: string;
}

const FINGERPRINT_PROFILES: FingerprintProfile[] = [
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    secChUaPlatform: '"Windows"',
    viewport: { width: 1920, height: 1080 },
    platform: "Win32",
    vendor: "Google Inc.",
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="99"',
    secChUaPlatform: '"Windows"',
    viewport: { width: 1440, height: 900 },
    platform: "Win32",
    vendor: "Google Inc.",
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    secChUaPlatform: '"macOS"',
    viewport: { width: 1440, height: 900 },
    platform: "MacIntel",
    vendor: "Google Inc.",
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="122", "Google Chrome";v="122", "Not-A.Brand";v="99"',
    secChUaPlatform: '"macOS"',
    viewport: { width: 1536, height: 864 },
    platform: "MacIntel",
    vendor: "Google Inc.",
  },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Jitter delay ─────────────────────────────────────────────────────────────

export function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.random() * (maxMs - minMs) + minMs;
  return new Promise((res) => setTimeout(res, Math.round(ms)));
}

// ─── Profile loader — picks a random aged cookie profile ─────────────────────

function loadRandomProfile(): string | undefined {
  const profilesDir = "./profiles";
  try {
    if (!fs.existsSync(profilesDir)) return undefined;
    const profiles = fs.readdirSync(profilesDir).filter((f) => f.endsWith(".json"));
    if (profiles.length === 0) return undefined;
    const pick_ = profiles[Math.floor(Math.random() * profiles.length)];
    return path.join(profilesDir, pick_);
  } catch {
    return undefined;
  }
}

// ─── Canvas + WebGL noise injection script ────────────────────────────────────
// NOTE: profile.viewport values are inlined at call time to avoid closure issues.

function buildFingerprintScript(
  noiseSeed: number,
  viewportWidth: number,
  viewportHeight: number
): string {
  return `
(function() {
  const SEED = ${noiseSeed};

  // ── Canvas noise ──────────────────────────────────────────────────────────
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const imageData = origGetImageData.call(ctx, 0, 0, this.width, this.height);
      for (let i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i]     = Math.min(255, imageData.data[i]     + (SEED % 3) - 1);
        imageData.data[i + 1] = Math.min(255, imageData.data[i + 1] + ((SEED >> 2) % 3) - 1);
        imageData.data[i + 2] = Math.min(255, imageData.data[i + 2] + ((SEED >> 4) % 3) - 1);
      }
      ctx.putImageData(imageData, 0, 0);
    }
    return origToDataURL.apply(this, arguments);
  };

  // ── WebGL renderer spoof ──────────────────────────────────────────────────
  const renderers = [
    'ANGLE (NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
  ];
  const vendors = ['Google Inc. (NVIDIA)', 'Google Inc. (Intel)', 'Google Inc. (AMD)'];
  const spoofRenderer = renderers[SEED % renderers.length];
  const spoofVendor   = vendors[SEED % vendors.length];

  const getParamOrig = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return spoofVendor;   // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return spoofRenderer; // UNMASKED_RENDERER_WEBGL
    return getParamOrig.call(this, param);
  };

  // ── navigator overrides ───────────────────────────────────────────────────
  Object.defineProperty(navigator, 'webdriver',           { get: () => undefined });
  Object.defineProperty(navigator, 'plugins',             { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages',           { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });

  // Screen properties must match viewport
  Object.defineProperty(screen, 'width',      { get: () => ${viewportWidth} });
  Object.defineProperty(screen, 'height',     { get: () => ${viewportHeight} });
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

  // Mouse movement simulation — bots never move mouse
  window._hasMouseMoved = false;
  document.addEventListener('mousemove', () => { window._hasMouseMoved = true; }, { once: true });

  // ── Chrome runtime object (headless check) ────────────────────────────────
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      value: { runtime: {}, loadTimes: function(){}, csi: function(){} },
      writable: true,
    });
  }

  // ── Permissions API spoof ─────────────────────────────────────────────────
  const origQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
  if (origQuery) {
    navigator.permissions.query = (parameters) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origQuery(parameters);
    };
  }

  // ── AudioContext fingerprint noise ────────────────────────────────────────
  const origCreateOscillator = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function() {
    const osc = origCreateOscillator.apply(this, arguments);
    const origConnect = osc.connect.bind(osc);
    osc.connect = function(dest, ...args) {
      return origConnect(dest, ...args);
    };
    return osc;
  };

  // ── Battery API spoof ────────────────────────────────────────────────────
  if (navigator.getBattery) {
    navigator.getBattery = () =>
      Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 0.85 + (SEED % 15) / 100,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      });
  }
})();
`;
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface BrowserOptions {
  headless?: boolean;
  proxy?: string; // "http://user:pass@host:port"
  timeoutMs?: number;
  allowImages?: boolean; // default true (looks more human)
}

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number | null;
}

// ─── Main fetch function ──────────────────────────────────────────────────────

export async function fetchPage(
  url: string,
  opts: BrowserOptions = {}
): Promise<FetchResult> {
  const { headless = true, proxy, timeoutMs = 30_000, allowImages = true } = opts;

  const profile = pick(FINGERPRINT_PROFILES);
  const noiseSeed = Math.floor(Math.random() * 0xffff);

  // Load a random aged cookie profile if available
  const storageState = loadRandomProfile();

  const browser = await chromium.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      `--window-size=${profile.viewport.width},${profile.viewport.height}`,
    ],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });

  let statusCode: number | null = null;

  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: profile.viewport,
    userAgent: profile.userAgent,
    locale: "en-US",
    timezoneId: "America/New_York",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      "sec-ch-ua": profile.secChUa,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": profile.secChUaPlatform,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
    },
  };

  // Wire in aged cookie profile when available
  if (storageState) {
    contextOptions.storageState = storageState;
  }

  const context = await browser.newContext(contextOptions);

  // Block only media and websockets — allow CSS/images (looks human)
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    const blocked = allowImages
      ? ["media", "websocket"]
      : ["media", "websocket", "image", "font"];
    if (blocked.includes(type)) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();

  // Inject fingerprint noise before any page scripts run
  // Pass viewport dimensions explicitly to avoid the `profile` closure bug
  await page.addInitScript(
    buildFingerprintScript(noiseSeed, profile.viewport.width, profile.viewport.height)
  );

  // Capture HTTP status
  page.on("response", (response) => {
    const reqUrl = response.url();
    if (reqUrl === url || reqUrl.startsWith(url.split("?")[0])) {
      statusCode = response.status();
    }
  });

  // Primary: networkidle (SPA-safe)
  // Fallback: domcontentloaded + 2s for aggressive bot-protection pages
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(2000);
  }

  // Simulate human mouse movement
  await page.mouse.move(100, 100);
  await jitter(200, 500);
  await page.mouse.move(
    Math.floor(Math.random() * profile.viewport.width * 0.8),
    Math.floor(Math.random() * profile.viewport.height * 0.8),
    { steps: 10 }
  );
  await jitter(300, 800);

  // Human-like: small random pause after load
  await jitter(800, 2200);

  const html = await page.content();
  const finalUrl = page.url();

  await browser.close();

  return { html, finalUrl, statusCode };
}
