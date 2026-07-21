/**
 * block-detector.ts — classify anti-bot blocks and CAPTCHA challenges.
 *
 * PURPOSE: honest detection, NOT defeat. When a site blocks the scraper this
 * names *what* blocked it and *what kind* of block it is, so the pipeline can
 * surface a structured "blocked" outcome instead of silently returning a
 * challenge page as if it were content. This is what production scrapers do:
 * degrade transparently, report the wall, let the caller decide (retry with a
 * browser, route through a paid path, or give up) — never attempt to crack the
 * human-verification challenge itself.
 *
 * Two axes:
 *   kind:
 *     - "none"        no block detected
 *     - "soft"        WAF/rate-limit block that a real browser might pass
 *                     (Cloudflare JS challenge, DataDome/PerimeterX/Akamai) —
 *                     worth escalating to Playwright
 *     - "interactive" a CAPTCHA demanding human action (hCaptcha, reCAPTCHA,
 *                     Cloudflare Turnstile) — a browser alone will NOT pass this
 *   vendor: the detected provider, for logging/analytics
 */

export type BlockKind = "none" | "soft" | "interactive";

export interface BlockSignal {
  blocked: boolean;
  kind: BlockKind;
  vendor: string | null;
  /** Human-readable reason for logs */
  reason: string | null;
  /** True when escalating to a headless browser could plausibly get past it */
  browserMayPass: boolean;
}

const NO_BLOCK: BlockSignal = {
  blocked: false,
  kind: "none",
  vendor: null,
  reason: null,
  browserMayPass: false,
};

/**
 * Interactive CAPTCHA challenges — a human must solve these. A headless browser
 * will NOT pass them on its own, so browserMayPass is false. We detect and
 * report; we never attempt to solve.
 */
const INTERACTIVE_PATTERNS: { vendor: string; re: RegExp }[] = [
  { vendor: "hCaptcha", re: /hcaptcha\.com|h-captcha|hcaptcha-box/i },
  { vendor: "reCAPTCHA", re: /recaptcha\/api|g-recaptcha|grecaptcha|recaptcha\.net/i },
  { vendor: "Cloudflare Turnstile", re: /challenges\.cloudflare\.com\/turnstile|cf-turnstile/i },
  { vendor: "Arkose/FunCaptcha", re: /funcaptcha|arkoselabs|fc-token/i },
];

/**
 * Soft blocks — WAF / bot-manager challenge or throttle pages. A real browser
 * (our stealth Playwright path) may transparently pass these, so browserMayPass
 * is true and the fetcher can escalate.
 */
const SOFT_PATTERNS: { vendor: string; re: RegExp }[] = [
  { vendor: "Cloudflare", re: /cf-browser-verification|challenge-form|jschl-answer|cf_chl_prog|attention required.*cloudflare/i },
  { vendor: "DataDome", re: /datadome|dd_cookie|geo\.captcha-delivery\.com/i },
  { vendor: "PerimeterX", re: /px-captcha|_pxhd|_px3|perimeterx|human-challenge/i },
  { vendor: "Akamai Bot Manager", re: /ak_bmsc|bm_sz|_abck|akamai.{0,40}bot/i },
  { vendor: "Imperva/Incapsula", re: /incapsula|_incap_|visid_incap|imperva/i },
];

// Generic block-page phrasing when no specific vendor matches.
const GENERIC_BLOCK = /access denied|request blocked|you have been blocked|unusual traffic|verify you are (?:a )?human|are you a robot|blocked for security/i;

/**
 * Classify a fetch outcome. Pass the response body and, when available, the
 * HTTP status — 403/429/503 with block markers is a strong signal.
 */
export function detectBlock(html: string, statusCode?: number | null): BlockSignal {
  const head = html.slice(0, 12000); // block markers live near the top

  // 1. Interactive CAPTCHAs first — most specific, and a browser won't help.
  for (const { vendor, re } of INTERACTIVE_PATTERNS) {
    if (re.test(head)) {
      return {
        blocked: true,
        kind: "interactive",
        vendor,
        reason: `${vendor} interactive CAPTCHA — human verification required`,
        browserMayPass: false,
      };
    }
  }

  // 2. Soft WAF / bot-manager blocks — a stealth browser may pass.
  for (const { vendor, re } of SOFT_PATTERNS) {
    if (re.test(head)) {
      return {
        blocked: true,
        kind: "soft",
        vendor,
        reason: `${vendor} bot-protection challenge`,
        browserMayPass: true,
      };
    }
  }

  // 3. Status-code block with generic phrasing, no named vendor.
  const statusBlocked = statusCode != null && [403, 429, 503].includes(statusCode);
  if (statusBlocked && GENERIC_BLOCK.test(head)) {
    return {
      blocked: true,
      kind: "soft",
      vendor: null,
      reason: `HTTP ${statusCode} block page`,
      browserMayPass: true,
    };
  }

  // 4. Generic block phrasing without a status signal (some WAFs serve 200).
  if (GENERIC_BLOCK.test(head)) {
    return {
      blocked: true,
      kind: "soft",
      vendor: null,
      reason: "Generic block/verification page",
      browserMayPass: true,
    };
  }

  return { ...NO_BLOCK };
}
