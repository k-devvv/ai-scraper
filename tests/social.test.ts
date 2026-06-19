/**
 * tests/social.test.ts
 * Tests for Phase 3c/3d: Nitter + session store + social routes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  importSession,
  getSession,
  listSessions,
  deleteSession,
  clearSessions,
  markUsed,
  markUnhealthy,
  toPlaywrightCookies,
  PLATFORM_CONFIGS,
  type BrowserCookie,
} from "../src/lib/session-store";
import { getNitterStatus } from "../src/lib/nitter";

// ── Test session dir ──────────────────────────────────────────────────────────

const TEST_SESSIONS_DIR = path.join(process.cwd(), ".sessions-test");

beforeEach(() => {
  process.env.SESSIONS_DIR = TEST_SESSIONS_DIR;
  if (fs.existsSync(TEST_SESSIONS_DIR)) {
    fs.rmSync(TEST_SESSIONS_DIR, { recursive: true });
  }
});

afterEach(() => {
  if (fs.existsSync(TEST_SESSIONS_DIR)) {
    fs.rmSync(TEST_SESSIONS_DIR, { recursive: true });
  }
  delete process.env.SESSIONS_DIR;
});

// ── Mock cookies ──────────────────────────────────────────────────────────────

const LINKEDIN_COOKIES: BrowserCookie[] = [
  { name: "li_at", value: "fake-token-123", domain: ".linkedin.com", path: "/" },
  { name: "JSESSIONID", value: "fake-jsession", domain: ".linkedin.com", path: "/" },
  { name: "lang", value: "v=2&lang=en-us", domain: ".linkedin.com", path: "/" },
];

const TWITTER_COOKIES: BrowserCookie[] = [
  { name: "auth_token", value: "fake-auth-token", domain: ".twitter.com", path: "/" },
  { name: "ct0", value: "fake-ct0", domain: ".twitter.com", path: "/" },
];

const INSTAGRAM_COOKIES: BrowserCookie[] = [
  { name: "sessionid", value: "fake-session-id", domain: ".instagram.com", path: "/" },
  { name: "csrftoken", value: "fake-csrf", domain: ".instagram.com", path: "/" },
];

// ── Platform configs ──────────────────────────────────────────────────────────

describe("PLATFORM_CONFIGS", () => {
  it("has configs for all supported platforms", () => {
    expect(PLATFORM_CONFIGS).toHaveProperty("linkedin");
    expect(PLATFORM_CONFIGS).toHaveProperty("instagram");
    expect(PLATFORM_CONFIGS).toHaveProperty("facebook");
    expect(PLATFORM_CONFIGS).toHaveProperty("twitter");
  });

  it("LinkedIn has correct rate limits", () => {
    expect(PLATFORM_CONFIGS.linkedin.delayBetweenRequestsMs).toBeGreaterThanOrEqual(8000);
    expect(PLATFORM_CONFIGS.linkedin.maxUsesPerDay).toBeLessThanOrEqual(200);
  });

  it("all platforms have required cookies defined", () => {
    for (const [name, config] of Object.entries(PLATFORM_CONFIGS)) {
      expect(config.requiredCookies.length).toBeGreaterThan(0);
      expect(config.domains.length).toBeGreaterThan(0);
    }
  });
});

// ── Session import ────────────────────────────────────────────────────────────

describe("importSession", () => {
  it("imports LinkedIn cookies", () => {
    const session = importSession("linkedin", LINKEDIN_COOKIES, "Test account");
    expect(session.id).toBeDefined();
    expect(session.platform).toBe("linkedin");
    expect(session.label).toBe("Test account");
    expect(session.cookies.length).toBeGreaterThan(0);
    expect(session.healthy).toBe(true);
  });

  it("imports Twitter cookies", () => {
    const session = importSession("twitter", TWITTER_COOKIES);
    expect(session.platform).toBe("twitter");
    expect(session.cookies.length).toBe(2);
  });

  it("imports Instagram cookies", () => {
    const session = importSession("instagram", INSTAGRAM_COOKIES);
    expect(session.platform).toBe("instagram");
  });

  it("rejects unknown platform", () => {
    expect(() => importSession("tiktok", [])).toThrow("Unknown platform");
  });

  it("rejects missing required cookies", () => {
    const incompleteCookies: BrowserCookie[] = [
      { name: "lang", value: "en", domain: ".linkedin.com", path: "/" },
    ];
    expect(() => importSession("linkedin", incompleteCookies)).toThrow("Missing required cookies");
  });

  it("persists to disk", () => {
    const session = importSession("linkedin", LINKEDIN_COOKIES);
    const files = fs.readdirSync(TEST_SESSIONS_DIR);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("linkedin");
  });
});

// ── Session retrieval ─────────────────────────────────────────────────────────

describe("getSession", () => {
  it("returns the session when available", () => {
    importSession("linkedin", LINKEDIN_COOKIES);
    const session = getSession("linkedin");
    expect(session).not.toBeNull();
    expect(session!.platform).toBe("linkedin");
  });

  it("returns null when no sessions exist", () => {
    const session = getSession("linkedin");
    expect(session).toBeNull();
  });

  it("returns null when all sessions are unhealthy", () => {
    const session = importSession("linkedin", LINKEDIN_COOKIES);
    markUnhealthy("linkedin", session.id);
    const result = getSession("linkedin");
    expect(result).toBeNull();
  });

  it("picks the least recently used session", () => {
    const s1 = importSession("linkedin", LINKEDIN_COOKIES, "session-1");
    const s2 = importSession("linkedin", LINKEDIN_COOKIES, "session-2");
    markUsed("linkedin", s1.id); // s1 was used more recently

    const result = getSession("linkedin");
    expect(result!.id).toBe(s2.id); // s2 should be picked (least recently used)
  });
});

// ── Session listing ───────────────────────────────────────────────────────────

describe("listSessions", () => {
  it("lists all sessions", () => {
    importSession("linkedin", LINKEDIN_COOKIES);
    importSession("twitter", TWITTER_COOKIES);
    const all = listSessions();
    expect(all.length).toBe(2);
  });

  it("filters by platform", () => {
    importSession("linkedin", LINKEDIN_COOKIES);
    importSession("twitter", TWITTER_COOKIES);
    const linkedin = listSessions("linkedin");
    expect(linkedin.length).toBe(1);
    expect(linkedin[0].platform).toBe("linkedin");
  });
});

// ── Session deletion ──────────────────────────────────────────────────────────

describe("deleteSession", () => {
  it("deletes a specific session", () => {
    const session = importSession("linkedin", LINKEDIN_COOKIES);
    const deleted = deleteSession("linkedin", session.id);
    expect(deleted).toBe(true);
    expect(listSessions("linkedin").length).toBe(0);
  });

  it("returns false for non-existent session", () => {
    expect(deleteSession("linkedin", "fake-id")).toBe(false);
  });
});

describe("clearSessions", () => {
  it("clears all sessions for a platform", () => {
    importSession("linkedin", LINKEDIN_COOKIES, "s1");
    importSession("linkedin", LINKEDIN_COOKIES, "s2");
    importSession("twitter", TWITTER_COOKIES);

    const cleared = clearSessions("linkedin");
    expect(cleared).toBe(2);
    expect(listSessions("linkedin").length).toBe(0);
    expect(listSessions("twitter").length).toBe(1); // twitter untouched
  });
});

// ── Playwright cookie conversion ──────────────────────────────────────────────

describe("toPlaywrightCookies", () => {
  it("converts to Playwright format", () => {
    const session = importSession("linkedin", LINKEDIN_COOKIES);
    const pwCookies = toPlaywrightCookies(session);

    expect(pwCookies.length).toBeGreaterThan(0);
    expect(pwCookies[0]).toHaveProperty("name");
    expect(pwCookies[0]).toHaveProperty("value");
    expect(pwCookies[0]).toHaveProperty("domain");
    expect(pwCookies[0]).toHaveProperty("sameSite");
    expect(typeof pwCookies[0].expires).toBe("number");
  });

  it("ensures domain starts with dot", () => {
    const session = importSession("linkedin", LINKEDIN_COOKIES);
    const pwCookies = toPlaywrightCookies(session);
    for (const c of pwCookies) {
      expect(c.domain.startsWith(".")).toBe(true);
    }
  });
});

// ── Nitter status ─────────────────────────────────────────────────────────────

describe("getNitterStatus", () => {
  it("returns instance list", () => {
    const status = getNitterStatus();
    expect(Array.isArray(status)).toBe(true);
    expect(status.length).toBeGreaterThan(0);
    expect(status[0]).toHaveProperty("url");
    expect(status[0]).toHaveProperty("healthy");
    expect(status[0]).toHaveProperty("failures");
  });
});
