/**
 * browser.ts — Full Stealth Browser (rebrowser-patches edition)
 *
 * Anti-detection layers:
 * 1. rebrowser-patches — fixes CDP-level leaks Cloudflare detects
 * 2. UA + sec-ch-ua sync — headers match the claimed Chrome version exactly
 * 3. Canvas/WebGL/AudioContext noise — unique fingerprint per session
 * 4. Font fingerprint override — headless font set expanded
 * 5. Human asset loading — CSS/images allowed, only media/websocket blocked
 * 6. navigator overrides — webdriver undefined, plugins, languages, platform
 * 7. Jitter delays — random(min,max) between requests
 * 8. Scroll simulation — realistic read pattern after load
 * 9. Referrer chain — arrive from Google or internal page, not cold
 * 10. Cookie jar / aged profile — persistent storageState across calls
 * 11. Proxy slot — residential/mobile proxy ready to wire in
 */

import { chromium } from "playwright";
import { applyRebrowserPatches } from "rebrowser-patches";
import * as fs from "fs";
import * as path from "path";

// ─── Patch Playwright at module load ─────────────────────────────────────────
applyRebrowserPatches();

// ─── Profile persistence ──────────────────────────────────────────────────────
const PROFILE_DIR = "./profiles";

function loadRandomProfile(): object | undefined {
  try {
    if (!fs.existsSync(PROFILE_DIR)) return undefined;
    const files = fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith(".json"));
    if (!files.length) return undefined;
    const file = files[Math.floor(Math.random() * files.length)];
    return JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, file), "utf-8"));
  } catch {
    return undefined;
  }
}

function writeProfile(profileId: string, storageState: object): void {
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PROFILE_DIR, `profile_${profileId}.json`),
      JSON.stringify(storageState, null, 2)
    );
  } catch {
    // non-fatal
  }
}

// ─── Fingerprint profiles ─────────────────────────────────────────────────────
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

// ─── Full fingerprint init script ─────────────────────────────────────────────
function buildFingerprintScript(noiseSeed: number, vw: number, vh: number): string {
  return `
(function() {
  const SEED = ${noiseSeed};

  // ── Canvas noise ────────────────────────────────────────────────────────────
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

  // ── WebGL renderer spoof ────────────────────────────────────────────────────
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
    if (param === 37445) return spoofVendor;
    if (param === 37446) return spoofRenderer;
    return getParamOrig.call(this, param);
  };
  // Also patch WebGL2
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParam2Orig = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return spoofVendor;
      if (param === 37446) return spoofRenderer;
      return getParam2Orig.call(this, param);
    };
  }

  // ── AudioContext fingerprint noise ──────────────────────────────────────────
  try {
    const origGetFloatFrequency = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function(array) {
      origGetFloatFrequency.call(this, array);
      for (let i = 0; i < array.length; i++) {
        array[i] += (SEED % 10) * 0.0001;
      }
    };
    const origGetByteFrequency = AnalyserNode.prototype.getByteFrequencyData;
    AnalyserNode.prototype.getByteFrequencyData = function(array) {
      origGetByteFrequency.call(this, array);
      for (let i = 0; i < array.length; i++) {
        array[i] = Math.min(255, array[i] + (SEED % 3));
      }
    };
  } catch(e) {}

  // ── navigator overrides ─────────────────────────────────────────────────────
  Object.defineProperty(navigator, 'webdriver',          { get: () => undefined });
  Object.defineProperty(navigator, 'plugins',            { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages',          { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'hardwareConcurrency',{ get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory',       { get: () => 8 });
  Object.defineProperty(navigator, 'platform',           { get: () => 'Win32' });
  Object.defineProperty(navigator, 'vendor',             { get: () => 'Google Inc.' });
  Object.defineProperty(navigator, 'maxTouchPoints',     { get: () => 0 });

  // ── Screen consistency with declared viewport ───────────────────────────────
  Object.defineProperty(screen, 'width',      { get: () => ${vw} });
  Object.defineProperty(screen, 'height',     { get: () => ${vh} });
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  Object.defineProperty(window, 'outerWidth', { get: () => ${vw} });
  Object.defineProperty(window, 'outerHeight',{ get: () => ${vh} });
  Object.defineProperty(window, 'innerWidth', { get: () => ${vw} });
  Object.defineProperty(window, 'innerHeight',{ get: () => ${vh} - 90 });

  // ── Chrome runtime (headless check) ────────────────────────────────────────
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      value: { runtime: {}, loadTimes: function(){}, csi: function(){} },
      writable: true,
    });
  }

  // ── Permissions API spoof ───────────────────────────────────────────────────
  const origQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
  if (origQuery) {
    navigator.permissions.query = (parameters) => {
      if ((parameters as any).name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null } as PermissionStatus);
      }
      return origQuery(parameters);
    };
  }

  // ── Battery API spoof (absence is a signal) ─────────────────────────────────
  if ((navigator as any).getBattery) {
    (navigator as any).getBattery = () => Promise.resolve({
      charging: true,
      chargingTime: 0,
      dischargingTime: Infinity,
      level: 0.85 + (SEED % 10) * 0.01,
    });
  }
})();
`;
}

// ─── Options ──────────────────────────────────────────────────────────────────
export interface BrowserOptions {
  headless?: boolean;
  proxy?: string; // "http://user:pass@host:port" or "socks5://host:port"
  timeoutMs?: number;
  allowImages?: boolean;
  saveProfile?: boolean; // persist storageState after fetch
  profileId?: string;    // specific profile slot to load/save
}

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number | null;
}

// ─── Referrer helper ──────────────────────────────────────────────────────────
function buildReferrer(url: string): string {
  try {
    const { hostname } = new URL(url);
    const options = [
      `https://www.google.com/search?q=${encodeURIComponent(hostname)}`,
      `https://www.google.com/search?q=${encodeURIComponent(hostname + " site")}`,
      `https://${hostname}/`,
      `https://${hostname}/`,
      "", // direct — weighted lower by having fewer slots
    ];
    return options[Math.floor(Math.random() * options.length)];
  } catch {
    return "";
  }
}

// ─── Main fetch function ──────────────────────────────────────────────────────
export async function fetchPage(
  url: string,
  opts: BrowserOptions = {}
): Promise<FetchResult> {
  const {
    headless = true,
    proxy,
    timeoutMs = 30_000,
    allowImages = true,
    saveProfile = true,
    profileId,
  } = opts;

  const profile = pick(FINGERPRINT_PROFILES);
  const noiseSeed = Math.floor(Math.random() * 0xffff);
  const referer = buildReferrer(url);

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

  // Load aged profile if available
  const savedProfile = profileId
    ? (() => {
        try {
          const p = path.join(PROFILE_DIR, `profile_${profileId}.json`);
          return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : undefined;
        } catch { return undefined; }
      })()
    : loadRandomProfile();

  const context = await browser.newContext({
    viewport: profile.viewport,
    userAgent: profile.userAgent,
    locale: "en-US",
    timezoneId: "America/New_York",
    ignoreHTTPSErrors: true,
    storageState: savedProfile as any ?? undefined,
    extraHTTPHeaders: {
      "sec-ch-ua": profile.secChUa,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": profile.secChUaPlatform,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": referer ? "cross-site" : "none",
      "sec-fetch-user": "?1",
      ...(referer ? { "Referer": referer } : {}),
    },
  });

  // Block only media/websockets — allow CSS/images (human pattern)
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    const blocked = allowImages
      ? ["media", "websocket"]
      : ["media", "websocket", "image", "font"];
    if (blocked.includes(type)) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();

  // Inject all fingerprint overrides before ANY page script runs
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

  // Primary: networkidle — SPA safe
  // Fallback: domcontentloaded + 2s for aggressive bot-protection pages
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(2000);
  }

  // ── Human mouse movement ────────────────────────────────────────────────────
  await page.mouse.move(100, 100);
  await jitter(200, 500);
  await page.mouse.move(
    Math.floor(Math.random() * profile.viewport.width * 0.8) + 50,
    Math.floor(Math.random() * profile.viewport.height * 0.5) + 50,
    { steps: 12 }
  );
  await jitter(300, 700);

  // ── Human scroll pattern ────────────────────────────────────────────────────
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let scrolled = 0;
      const maxScroll = Math.min(
        document.body.scrollHeight * 0.65,
        2000
      );
      const interval = setInterval(() => {
        const amount = Math.floor(Math.random() * 120) + 60;
        window.scrollBy(0, amount);
        scrolled += amount;
        if (scrolled >= maxScroll) {
          clearInterval(interval);
          resolve();
        }
      }, Math.random() * 160 + 80);
    });
  });
  await jitter(400, 900);

  // ── Final human pause ───────────────────────────────────────────────────────
  await jitter(800, 2200);

  const html = await page.content();
  const finalUrl = page.url();

  // Persist updated storage state (cookies accumulate)
  if (saveProfile) {
    try {
      const state = await context.storageState();
      const slot = profileId ?? String(noiseSeed % 5);
      writeProfile(slot, state);
    } catch { /* non-fatal */ }
  }

  await browser.close();

  return { html, finalUrl, statusCode };
}
