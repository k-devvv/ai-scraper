/**
 * profile-seeder.ts
 *
 * Builds aged browser profiles by:
 * 1. Visiting real warm sites (Google, Reddit, GitHub etc.) to accumulate genuine cookies
 * 2. Seeding realistic aged localStorage + GA cookies on the target domain
 * 3. Navigating a few internal pages to build window.history.length > 1
 * 4. Saving the full Playwright storageState as a JSON profile
 *
 * Usage:
 *   npx tsx profile-seeder.ts                         # seed 5 generic profiles
 *   npx tsx profile-seeder.ts producthunt.com         # seed 5 profiles warmed on target
 *   npx tsx profile-seeder.ts producthunt.com 10      # seed 10 profiles
 */

import { chromium } from "playwright";
import { applyRebrowserPatches } from "rebrowser-patches";
import * as fs from "fs";
import * as path from "path";

applyRebrowserPatches();

const PROFILE_DIR = "./profiles";
const DEFAULT_COUNT = 5;

// Real sites that set genuine cross-site cookies (GA, analytics etc.)
const WARM_SITES = [
  "https://www.google.com",
  "https://www.reddit.com",
  "https://news.ycombinator.com",
  "https://github.com",
  "https://www.wikipedia.org",
  "https://www.youtube.com",
];

const FINGERPRINT_PROFILES = [
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
  },
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1536, height: 864 },
  },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Builds localStorage keys that look like a real returning visitor
function buildAgedStorageSeeds(targetDomain: string): Record<string, string> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const sevenDaysAgo  = Date.now() - 7  * 24 * 60 * 60 * 1000;

  return {
    // Google Analytics — present on almost every site, checked by DataDome etc.
    _ga:  `GA1.1.${Math.floor(Math.random() * 1e9)}.${Math.floor(thirtyDaysAgo / 1000)}`,
    _gid: `GA1.1.${Math.floor(Math.random() * 1e9)}.${Math.floor(sevenDaysAgo / 1000)}`,
    // Generic returning-visitor signals
    __visited:      "1",
    __visit_count:  String(Math.floor(Math.random() * 15) + 3),
    __first_visit:  String(thirtyDaysAgo),
    __last_visit:   String(sevenDaysAgo),
    // Cookie consent — absence is a bot signal on EU/compliant sites
    cookieConsent:  "true",
    gdpr_consent:   "1",
    cookie_consent: "accepted",
    // User preferences (real users have these)
    theme:          Math.random() > 0.5 ? "light" : "dark",
    lang:           "en",
    locale:         "en-US",
  };
}

// Builds realistic aged cookies for the target domain
function buildAgedCookies(domain: string): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}> {
  const thirtyDaysAgo  = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  const sevenDaysAgo   = (Date.now() - 7  * 24 * 60 * 60 * 1000) / 1000;
  const futureExpiry   = (Date.now() + 365 * 24 * 60 * 60 * 1000) / 1000;
  const shortExpiry    = (Date.now() + 24 * 60 * 60 * 1000) / 1000;

  return [
    {
      name:     "_ga",
      value:    `GA1.1.${Math.floor(Math.random() * 1e9)}.${Math.floor(thirtyDaysAgo)}`,
      domain:   `.${domain}`,
      path:     "/",
      expires:  futureExpiry,
      httpOnly: false,
      secure:   false,
      sameSite: "Lax",
    },
    {
      name:     "_gid",
      value:    `GA1.1.${Math.floor(Math.random() * 1e9)}.${Math.floor(sevenDaysAgo)}`,
      domain:   `.${domain}`,
      path:     "/",
      expires:  shortExpiry,
      httpOnly: false,
      secure:   false,
      sameSite: "Lax",
    },
    {
      name:     "visited",
      value:    "1",
      domain:   `.${domain}`,
      path:     "/",
      expires:  futureExpiry,
      httpOnly: false,
      secure:   true,
      sameSite: "Lax",
    },
    {
      name:     "cookieConsent",
      value:    "true",
      domain:   `.${domain}`,
      path:     "/",
      expires:  futureExpiry,
      httpOnly: false,
      secure:   false,
      sameSite: "Lax",
    },
  ];
}

async function createAgedProfile(
  profileId: number,
  targetDomain?: string
): Promise<string> {
  const profilePath = path.join(PROFILE_DIR, `profile_${profileId}.json`);
  const fp = pick(FINGERPRINT_PROFILES);

  console.log(`  Building profile ${profileId} (${fp.viewport.width}x${fp.viewport.height})...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport:  fp.viewport,
    userAgent: fp.userAgent,
    locale:    "en-US",
    timezoneId:"America/New_York",
  });

  const page = await context.newPage();

  // ── Step 1: Visit warm sites to accumulate real cross-site cookies ──────────
  console.log(`    Warming on ${WARM_SITES.length} sites...`);
  for (const site of WARM_SITES) {
    try {
      await page.goto(site, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(Math.random() * 1500 + 500);
      await page.evaluate(() => window.scrollBy(0, Math.random() * 300 + 200));
      await page.waitForTimeout(500);
    } catch {
      // Non-fatal — some sites may timeout or block headless, that's fine
    }
  }

  // ── Step 2: Warm and seed the target domain ─────────────────────────────────
  if (targetDomain) {
    console.log(`    Seeding target domain: ${targetDomain}...`);
    try {
      await page.goto(`https://${targetDomain}`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });

      // Inject aged localStorage
      const seeds = buildAgedStorageSeeds(targetDomain);
      await page.evaluate((data) => {
        Object.entries(data).forEach(([k, v]) => {
          try { localStorage.setItem(k, v); } catch {}
        });
      }, seeds);

      // Inject aged cookies
      const cookies = buildAgedCookies(targetDomain);
      await context.addCookies(cookies);

      // Navigate a few internal pages to build window.history.length
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((h) => h.startsWith(window.location.origin) && !h.includes("#"))
          .slice(0, 3)
      );

      for (const link of links) {
        try {
          await page.goto(link, { waitUntil: "domcontentloaded", timeout: 10_000 });
          await page.evaluate(() => window.scrollBy(0, Math.random() * 400 + 100));
          await page.waitForTimeout(Math.random() * 1000 + 400);
        } catch { /* continue */ }
      }
    } catch {
      // Target unreachable — profile still has warm-site cookies, still valuable
      console.log(`    Target unreachable, profile saved with warm-site cookies only`);
    }
  }

  // ── Step 3: Save full browser state ────────────────────────────────────────
  const storageState = await context.storageState();
  await browser.close();

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(storageState, null, 2));

  console.log(
    `  ✓ profile_${profileId}.json — ${storageState.cookies.length} cookies, ` +
    `${storageState.origins.length} origins with localStorage`
  );
  return profilePath;
}

export async function seedProfiles(
  targetDomain?: string,
  count: number = DEFAULT_COUNT
): Promise<string[]> {
  console.log(`\nSeeding ${count} aged profiles${targetDomain ? ` for ${targetDomain}` : ""}...\n`);
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = await createAgedProfile(i, targetDomain);
    paths.push(p);
  }

  console.log(`\nDone. ${paths.length} profiles saved to ./${PROFILE_DIR}/`);
  return paths;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────
// npx tsx profile-seeder.ts [domain] [count]
const isMain =
  process.argv[1] &&
  (process.argv[1].includes("profile-seeder") ||
   process.argv[1].endsWith("profile-seeder.ts"));

if (isMain) {
  const domain = process.argv[2] ?? undefined;
  const count  = process.argv[3] ? parseInt(process.argv[3], 10) : DEFAULT_COUNT;
  seedProfiles(domain, count).catch(console.error);
}
