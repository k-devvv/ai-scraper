/**
 * src/lib/nitter.ts
 * Nitter integration — scrape Twitter/X public data for free.
 *
 * Nitter is an open-source Twitter frontend that serves public profiles,
 * tweets, and search results without requiring a Twitter account or API key.
 *
 * This module:
 *   - Maintains a list of public Nitter instances
 *   - Health-checks instances and rotates between them
 *   - Parses profile data, tweets, and search results
 *   - Falls back to the next instance on failure
 *
 * Limitations:
 *   - Only PUBLIC data (private/protected accounts won't work)
 *   - Nitter instances go up and down — the health checker handles this
 *   - Some instances have rate limits — rotation spreads the load
 */

import * as cheerio from "cheerio";
import { fetchPage } from "../fetcher";

// ── Nitter instance registry ──────────────────────────────────────────────────

interface NitterInstance {
  url: string;
  healthy: boolean;
  lastChecked: number;
  lastUsed: number;
  failures: number;
}

const DEFAULT_INSTANCES = [
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.lunar.icu",
  "https://nitter.cz",
  "https://nitter.projectsegfau.lt",
  "https://nitter.1d4.us",
];

let instances: NitterInstance[] = DEFAULT_INSTANCES.map((url) => ({
  url,
  healthy: true,
  lastChecked: 0,
  lastUsed: 0,
  failures: 0,
}));

/** Add a custom Nitter instance (e.g. self-hosted) */
export function addNitterInstance(url: string): void {
  const normalized = url.replace(/\/$/, "");
  if (instances.some((i) => i.url === normalized)) return;
  instances.push({
    url: normalized,
    healthy: true,
    lastChecked: 0,
    lastUsed: 0,
    failures: 0,
  });
}

/** Get the next healthy instance (round-robin by least recently used) */
function getNextInstance(): NitterInstance | null {
  const healthy = instances.filter((i) => i.healthy && i.failures < 3);
  if (healthy.length === 0) {
    // Reset all instances and try again
    instances.forEach((i) => {
      i.healthy = true;
      i.failures = 0;
    });
    return instances[0] ?? null;
  }
  healthy.sort((a, b) => a.lastUsed - b.lastUsed);
  return healthy[0];
}

function markFailed(instance: NitterInstance): void {
  instance.failures++;
  if (instance.failures >= 3) {
    instance.healthy = false;
    console.warn(`[nitter] Instance ${instance.url} marked unhealthy after 3 failures`);
    // Auto-recover after 30 minutes
    setTimeout(() => {
      instance.failures = 0;
      instance.healthy = true;
    }, 30 * 60 * 1000).unref();
  }
}

// ── Fetch via Nitter ──────────────────────────────────────────────────────────

async function fetchViaNitter(
  path: string,
  proxy?: string
): Promise<{ html: string; instanceUrl: string }> {
  const maxAttempts = Math.min(instances.length, 5);

  for (let i = 0; i < maxAttempts; i++) {
    const instance = getNextInstance();
    if (!instance) throw new Error("No healthy Nitter instances available");

    const url = `${instance.url}${path}`;
    instance.lastUsed = Date.now();

    try {
      const result = await fetchPage(url, {
        mode: "fast",
        proxy,
        timeoutMs: 10_000,
      });

      // Check if Nitter returned an error page
      if (
        result.statusCode === 200 &&
        !result.html.includes("error-panel") &&
        result.html.length > 500
      ) {
        instance.failures = Math.max(0, instance.failures - 1);
        return { html: result.html, instanceUrl: instance.url };
      }

      markFailed(instance);
    } catch {
      markFailed(instance);
    }
  }

  throw new Error(`All ${maxAttempts} Nitter instances failed for path: ${path}`);
}

// ── Parse profile ─────────────────────────────────────────────────────────────

export interface TwitterProfile {
  username: string;
  displayName: string;
  bio: string;
  location: string;
  website: string;
  joinDate: string;
  followersCount: string;
  followingCount: string;
  tweetsCount: string;
  avatarUrl: string;
  bannerUrl: string;
  verified: boolean;
}

export async function scrapeTwitterProfile(
  handle: string,
  proxy?: string
): Promise<TwitterProfile> {
  const cleanHandle = handle.replace(/^@/, "").trim();
  const { html, instanceUrl } = await fetchViaNitter(`/${cleanHandle}`, proxy);
  const $ = cheerio.load(html);

  const profile: TwitterProfile = {
    username: cleanHandle,
    displayName: $(".profile-card-fullname").text().trim() || "",
    bio: $(".profile-bio").text().trim() || "",
    location: $(".profile-location").text().trim() || "",
    website: $(".profile-website a").attr("href") || "",
    joinDate: $(".profile-joindate span").text().trim() || "",
    followersCount:
      $(".profile-stat-num").eq(2).text().trim() ||
      $('[data-stat="followers"] .profile-stat-num').text().trim() ||
      "0",
    followingCount:
      $(".profile-stat-num").eq(1).text().trim() ||
      $('[data-stat="following"] .profile-stat-num').text().trim() ||
      "0",
    tweetsCount:
      $(".profile-stat-num").eq(0).text().trim() ||
      $('[data-stat="tweets"] .profile-stat-num').text().trim() ||
      "0",
    avatarUrl: resolveUrl($(".profile-card-avatar img").attr("src") || "", instanceUrl),
    bannerUrl: resolveUrl($(".profile-banner img").attr("src") || "", instanceUrl),
    verified: $(".verified-icon").length > 0,
  };

  if (!profile.displayName && !profile.bio) {
    throw new Error(
      `Profile @${cleanHandle} not found or is private. Nitter only shows public profiles.`
    );
  }

  return profile;
}

// ── Parse tweets ──────────────────────────────────────────────────────────────

export interface Tweet {
  id: string;
  text: string;
  date: string;
  retweets: string;
  likes: string;
  replies: string;
  isRetweet: boolean;
  isPinned: boolean;
  hasMedia: boolean;
  link: string;
}

export async function scrapeTwitterTweets(
  handle: string,
  opts?: { maxTweets?: number; proxy?: string }
): Promise<Tweet[]> {
  const cleanHandle = handle.replace(/^@/, "").trim();
  const maxTweets = opts?.maxTweets ?? 20;
  const { html, instanceUrl } = await fetchViaNitter(`/${cleanHandle}`, opts?.proxy);
  const $ = cheerio.load(html);

  const tweets: Tweet[] = [];

  $(".timeline-item").each((_i, el) => {
    if (tweets.length >= maxTweets) return false;

    const $item = $(el);
    const tweetLink = $item.find(".tweet-link").attr("href") || "";
    const tweetId = tweetLink.split("/").pop() || "";

    tweets.push({
      id: tweetId,
      text: $item.find(".tweet-content").text().trim(),
      date: $item.find(".tweet-date a").attr("title") || $item.find(".tweet-date a").text().trim(),
      retweets: $item.find(".icon-retweet").parent().text().trim() || "0",
      likes: $item.find(".icon-heart").parent().text().trim() || "0",
      replies: $item.find(".icon-comment").parent().text().trim() || "0",
      isRetweet: $item.hasClass("retweet"),
      isPinned: $item.find(".pinned").length > 0,
      hasMedia: $item.find(".attachments").length > 0,
      link: `https://twitter.com${tweetLink}`,
    });
  });

  return tweets;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface TwitterSearchResult {
  query: string;
  tweets: Tweet[];
}

export async function searchTwitter(
  query: string,
  opts?: { maxResults?: number; proxy?: string }
): Promise<TwitterSearchResult> {
  const maxResults = opts?.maxResults ?? 20;
  const encodedQuery = encodeURIComponent(query);
  const { html } = await fetchViaNitter(`/search?f=tweets&q=${encodedQuery}`, opts?.proxy);
  const $ = cheerio.load(html);

  const tweets: Tweet[] = [];

  $(".timeline-item").each((_i, el) => {
    if (tweets.length >= maxResults) return false;

    const $item = $(el);
    const tweetLink = $item.find(".tweet-link").attr("href") || "";

    tweets.push({
      id: tweetLink.split("/").pop() || "",
      text: $item.find(".tweet-content").text().trim(),
      date: $item.find(".tweet-date a").attr("title") || "",
      retweets: $item.find(".icon-retweet").parent().text().trim() || "0",
      likes: $item.find(".icon-heart").parent().text().trim() || "0",
      replies: $item.find(".icon-comment").parent().text().trim() || "0",
      isRetweet: $item.hasClass("retweet"),
      isPinned: false,
      hasMedia: $item.find(".attachments").length > 0,
      link: `https://twitter.com${tweetLink}`,
    });
  });

  return { query, tweets };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveUrl(path: string, baseUrl: string): string {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return `${baseUrl}${path}`;
}

/** Get the health status of all Nitter instances */
export function getNitterStatus(): Array<{
  url: string;
  healthy: boolean;
  failures: number;
}> {
  return instances.map((i) => ({
    url: i.url,
    healthy: i.healthy,
    failures: i.failures,
  }));
}
