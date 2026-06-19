/**
 * src/lib/session-store.ts
 * Cookie session store — persist authenticated browser sessions.
 *
 * How it works:
 *   1. User logs into LinkedIn/Instagram/etc. in their real browser
 *   2. Exports cookies via browser extension (EditThisCookie, Cookie-Editor)
 *   3. POSTs the cookies to /v1/sessions/import
 *   4. Scraper injects cookies into Playwright — browses as a logged-in user
 *
 * Sessions are stored in .sessions/ directory as JSON files.
 * Each platform can have multiple sessions for rotation (avoids ban).
 *
 * Security:
 *   - Cookie files are gitignored (.sessions/ is in .gitignore)
 *   - Passwords are never stored — only session cookies
 *   - Sessions expire naturally (platform-set cookie expiry)
 */

import fs from "fs";
import path from "path";

function getSessionsDir(): string {
  return process.env.SESSIONS_DIR ?? path.join(process.cwd(), ".sessions");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface SessionRecord {
  id: string;
  platform: string;
  label: string;
  cookies: BrowserCookie[];
  userAgent: string;
  viewport: { width: number; height: number };
  createdAt: number;
  lastUsed: number;
  useCount: number;
  maxUsesPerDay: number;
  healthy: boolean;
}

// ── Platform configs ──────────────────────────────────────────────────────────

export interface PlatformConfig {
  name: string;
  domains: string[];
  requiredCookies: string[];
  maxRequestsPerMinute: number;
  maxUsesPerDay: number;
  delayBetweenRequestsMs: number;
  userAgent: string;
}

export const PLATFORM_CONFIGS: Record<string, PlatformConfig> = {
  linkedin: {
    name: "LinkedIn",
    domains: [".linkedin.com", "www.linkedin.com"],
    requiredCookies: ["li_at", "JSESSIONID"],
    maxRequestsPerMinute: 8,
    maxUsesPerDay: 200,
    delayBetweenRequestsMs: 8000, // 1 req per 8 seconds — critical for LinkedIn
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  },
  instagram: {
    name: "Instagram",
    domains: [".instagram.com", "www.instagram.com"],
    requiredCookies: ["sessionid", "csrftoken"],
    maxRequestsPerMinute: 10,
    maxUsesPerDay: 300,
    delayBetweenRequestsMs: 6000,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  },
  facebook: {
    name: "Facebook",
    domains: [".facebook.com", "www.facebook.com"],
    requiredCookies: ["c_user", "xs"],
    maxRequestsPerMinute: 8,
    maxUsesPerDay: 200,
    delayBetweenRequestsMs: 8000,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  },
  twitter: {
    name: "Twitter/X",
    domains: [".twitter.com", ".x.com", "twitter.com", "x.com"],
    requiredCookies: ["auth_token", "ct0"],
    maxRequestsPerMinute: 15,
    maxUsesPerDay: 500,
    delayBetweenRequestsMs: 4000,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(getSessionsDir())) {
    fs.mkdirSync(getSessionsDir(), { recursive: true });
  }
}

function sessionPath(platform: string, id: string): string {
  return path.join(getSessionsDir(), `${platform}_${id}.json`);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Import a new session from exported browser cookies */
export function importSession(
  platform: string,
  cookies: BrowserCookie[],
  label?: string
): SessionRecord {
  ensureDir();

  const config = PLATFORM_CONFIGS[platform];
  if (!config) {
    throw new Error(
      `Unknown platform: ${platform}. Available: ${Object.keys(PLATFORM_CONFIGS).join(", ")}`
    );
  }

  // Validate required cookies are present
  const cookieNames = new Set(cookies.map((c) => c.name));
  const missing = config.requiredCookies.filter((c) => !cookieNames.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Missing required cookies for ${config.name}: ${missing.join(", ")}. ` +
        `Make sure you export all cookies from ${config.domains[0]}`
    );
  }

  // Filter to only platform-relevant cookies
  const platformCookies = cookies.filter((c) =>
    config.domains.some((d) => c.domain.includes(d.replace(/^\./, "")))
  );

  const session: SessionRecord = {
    id: generateId(),
    platform,
    label: label ?? `${config.name} session`,
    cookies: platformCookies.length > 0 ? platformCookies : cookies,
    userAgent: config.userAgent,
    viewport: { width: 1920, height: 1080 },
    createdAt: Date.now(),
    lastUsed: 0,
    useCount: 0,
    maxUsesPerDay: config.maxUsesPerDay,
    healthy: true,
  };

  fs.writeFileSync(sessionPath(platform, session.id), JSON.stringify(session, null, 2));
  return session;
}

/** Get the best available session for a platform (least recently used) */
export function getSession(platform: string): SessionRecord | null {
  ensureDir();
  const sessions = listSessions(platform).filter((s) => s.healthy);

  if (sessions.length === 0) return null;

  // Check daily use limits and pick the least-used session
  const today = new Date().toDateString();
  const available = sessions.filter((s) => {
    const lastUsedDay = new Date(s.lastUsed).toDateString();
    if (lastUsedDay === today && s.useCount >= s.maxUsesPerDay) return false;
    return true;
  });

  if (available.length === 0) {
    console.warn(`[session] All ${platform} sessions hit daily limit`);
    return null;
  }

  // Sort by least recently used
  available.sort((a, b) => a.lastUsed - b.lastUsed);
  return available[0];
}

/** Mark a session as used (increment counter, update timestamp) */
export function markUsed(platform: string, id: string): void {
  const filepath = sessionPath(platform, id);
  if (!fs.existsSync(filepath)) return;

  const session = JSON.parse(fs.readFileSync(filepath, "utf-8")) as SessionRecord;
  session.lastUsed = Date.now();
  session.useCount++;
  fs.writeFileSync(filepath, JSON.stringify(session, null, 2));
}

/** Mark a session as unhealthy (probably expired or detected) */
export function markUnhealthy(platform: string, id: string, reason?: string): void {
  const filepath = sessionPath(platform, id);
  if (!fs.existsSync(filepath)) return;

  const session = JSON.parse(fs.readFileSync(filepath, "utf-8")) as SessionRecord;
  session.healthy = false;
  fs.writeFileSync(filepath, JSON.stringify(session, null, 2));
  console.warn(
    `[session] ${platform}/${id} marked unhealthy${reason ? `: ${reason}` : ""}`
  );
}

/** List all sessions for a platform (or all platforms) */
export function listSessions(platform?: string): SessionRecord[] {
  ensureDir();
  const files = fs.readdirSync(getSessionsDir()).filter((f) => f.endsWith(".json"));

  const sessions: SessionRecord[] = [];
  for (const file of files) {
    try {
      const session = JSON.parse(
        fs.readFileSync(path.join(getSessionsDir(), file), "utf-8")
      ) as SessionRecord;
      if (!platform || session.platform === platform) {
        sessions.push(session);
      }
    } catch {
      // skip corrupt files
    }
  }

  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

/** Delete a session */
export function deleteSession(platform: string, id: string): boolean {
  const filepath = sessionPath(platform, id);
  if (!fs.existsSync(filepath)) return false;
  fs.unlinkSync(filepath);
  return true;
}

/** Delete all sessions for a platform */
export function clearSessions(platform: string): number {
  const sessions = listSessions(platform);
  let count = 0;
  for (const s of sessions) {
    if (deleteSession(s.platform, s.id)) count++;
  }
  return count;
}

/** Convert session cookies to Playwright-compatible format */
export function toPlaywrightCookies(
  session: SessionRecord
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}> {
  return session.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
    path: c.path || "/",
    expires: c.expires ?? Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days default
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
    sameSite: c.sameSite ?? "None",
  }));
}
