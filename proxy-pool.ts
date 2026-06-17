/**
 * proxy-pool.ts — Rotating proxy pool with health tracking + ban-aware rotation.
 *
 * This is the missing piece vs. Scrapling's spider proxy rotation. The old
 * fetcher accepted a single static `proxy` string; this manages a pool.
 *
 * Sources (first that resolves wins):
 *   1. PROXY_LIST env  — comma-separated proxy URLs
 *   2. PROXY_FILE env  — path to a newline-delimited file (default ./proxies.txt)
 *
 * Proxy URL format (auth optional):
 *   http://user:pass@host:port
 *   https://host:port
 *   socks5://user:pass@host:port      (Playwright modes only — Axios needs http/https)
 *
 * Strategies:
 *   round-robin (default) — even spread across healthy proxies
 *   random                — pick any healthy proxy
 *   sticky                — pin one proxy per domain until it gets banned
 *
 * Ban handling:
 *   report(url, 'ban')   → quarantine for PROXY_BAN_COOLDOWN_MS, drop sticky binding
 *   report(url, 'error') → after PROXY_MAX_FAILURES consecutive, short cooldown
 *   report(url, 'success') → reset failure streak, mark healthy
 */

import fs from "fs";

export type RotationStrategy = "round-robin" | "random" | "sticky";
export type ProxyOutcome = "success" | "ban" | "error";

export interface ProxyEntry {
  url: string; // full normalized URL incl. credentials
  protocol: string; // http: | https: | socks5: ...
  host: string;
  port: string;
  label: string; // protocol://host:port (credentials stripped — safe to log/show)
  healthy: boolean;
  cooldownUntil: number; // epoch ms; 0 = available now
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastUsedAt: number;
  totalLatencyMs: number;
  bans: number;
}

export interface ProxyStat {
  label: string;
  protocol: string;
  state: "healthy" | "cooling" | "quarantined";
  successes: number;
  failures: number;
  bans: number;
  avgLatencyMs: number | null;
  successRate: number | null; // 0..1
  cooldownRemainingMs: number;
}

export interface PoolStats {
  enabled: boolean;
  strategy: RotationStrategy;
  total: number;
  healthy: number;
  cooling: number;
  quarantined: number;
  proxies: ProxyStat[];
}

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function domainOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
}

export class ProxyPool {
  private entries: ProxyEntry[] = [];
  private cursor = 0;
  private sticky = new Map<string, string>(); // domain -> proxy.url
  private readonly strategy: RotationStrategy;
  private readonly banCooldownMs: number;
  private readonly errorCooldownMs: number;
  private readonly maxFailures: number;

  constructor(opts?: {
    proxies?: string[];
    strategy?: RotationStrategy;
    banCooldownMs?: number;
    errorCooldownMs?: number;
    maxFailures?: number;
  }) {
    this.strategy =
      opts?.strategy ??
      (process.env.PROXY_STRATEGY as RotationStrategy) ??
      "round-robin";
    this.banCooldownMs =
      opts?.banCooldownMs ?? envInt("PROXY_BAN_COOLDOWN_MS", 5 * 60_000);
    this.errorCooldownMs =
      opts?.errorCooldownMs ?? envInt("PROXY_ERROR_COOLDOWN_MS", 60_000);
    this.maxFailures = opts?.maxFailures ?? envInt("PROXY_MAX_FAILURES", 3);

    const list = opts?.proxies ?? ProxyPool.loadFromEnv();
    this.load(list);
  }

  static loadFromEnv(): string[] {
    if (process.env.PROXY_LIST) {
      return process.env.PROXY_LIST.split(",").map((s) => s.trim()).filter(Boolean);
    }
    const file = process.env.PROXY_FILE ?? "./proxies.txt";
    try {
      if (fs.existsSync(file)) {
        return fs
          .readFileSync(file, "utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#"));
      }
    } catch {
      /* ignore — pool just stays empty */
    }
    return [];
  }

  /** Replace the pool contents at runtime (used by the /v1/proxies reload route). */
  load(proxyUrls: string[]): void {
    const next: ProxyEntry[] = [];
    for (const raw of proxyUrls) {
      try {
        const u = new URL(raw);
        next.push({
          url: u.href,
          protocol: u.protocol,
          host: u.hostname,
          port: u.port || (u.protocol === "https:" ? "443" : "80"),
          label: `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`,
          healthy: true,
          cooldownUntil: 0,
          successes: 0,
          failures: 0,
          consecutiveFailures: 0,
          lastUsedAt: 0,
          totalLatencyMs: 0,
          bans: 0,
        });
      } catch {
        // Skip malformed proxy strings rather than crash the pool.
      }
    }
    this.entries = next;
    this.cursor = 0;
    this.sticky.clear();
  }

  get enabled(): boolean {
    return this.entries.length > 0;
  }

  get size(): number {
    return this.entries.length;
  }

  private isAvailable(e: ProxyEntry, now: number): boolean {
    return e.cooldownUntil <= now;
  }

  /**
   * Acquire a proxy URL for a request. Returns null when the pool is empty or
   * every proxy is in cooldown (caller should then fetch directly).
   */
  acquire(targetUrl?: string): string | null {
    if (!this.enabled) return null;
    const now = Date.now();
    const available = this.entries.filter((e) => this.isAvailable(e, now));
    if (available.length === 0) return null;

    let chosen: ProxyEntry;

    if (this.strategy === "sticky" && targetUrl) {
      const domain = domainOf(targetUrl);
      const pinned = this.sticky.get(domain);
      const stillGood =
        pinned && available.find((e) => e.url === pinned);
      if (stillGood) {
        chosen = stillGood;
      } else {
        chosen = available[Math.floor(Math.random() * available.length)];
        this.sticky.set(domain, chosen.url);
      }
    } else if (this.strategy === "random") {
      chosen = available[Math.floor(Math.random() * available.length)];
    } else {
      // round-robin over the *available* set
      this.cursor = (this.cursor + 1) % available.length;
      chosen = available[this.cursor];
    }

    chosen.lastUsedAt = now;
    return chosen.url;
  }

  /** Report the outcome of a request so the pool can self-heal / rotate. */
  report(proxyUrl: string, outcome: ProxyOutcome, latencyMs?: number): void {
    const e = this.entries.find((x) => x.url === proxyUrl);
    if (!e) return;
    const now = Date.now();

    if (outcome === "success") {
      e.successes++;
      e.consecutiveFailures = 0;
      e.healthy = true;
      e.cooldownUntil = 0;
      if (typeof latencyMs === "number") e.totalLatencyMs += latencyMs;
      return;
    }

    e.failures++;
    e.consecutiveFailures++;

    if (outcome === "ban") {
      e.bans++;
      e.healthy = false;
      e.cooldownUntil = now + this.banCooldownMs;
      // Drop any sticky bindings pointing at this proxy so we rotate next time.
      for (const [domain, url] of this.sticky.entries()) {
        if (url === proxyUrl) this.sticky.delete(domain);
      }
      return;
    }

    // outcome === "error"
    if (e.consecutiveFailures >= this.maxFailures) {
      e.healthy = false;
      e.cooldownUntil = now + this.errorCooldownMs;
    }
  }

  stats(): PoolStats {
    const now = Date.now();
    const proxies: ProxyStat[] = this.entries.map((e) => {
      const cooling = e.cooldownUntil > now;
      const state: ProxyStat["state"] = !cooling
        ? "healthy"
        : e.bans > 0 && e.cooldownUntil - now > this.errorCooldownMs
          ? "quarantined"
          : "cooling";
      const attempts = e.successes + e.failures;
      return {
        label: e.label,
        protocol: e.protocol.replace(":", ""),
        state,
        successes: e.successes,
        failures: e.failures,
        bans: e.bans,
        avgLatencyMs: e.successes > 0 ? Math.round(e.totalLatencyMs / e.successes) : null,
        successRate: attempts > 0 ? e.successes / attempts : null,
        cooldownRemainingMs: cooling ? e.cooldownUntil - now : 0,
      };
    });
    return {
      enabled: this.enabled,
      strategy: this.strategy,
      total: proxies.length,
      healthy: proxies.filter((p) => p.state === "healthy").length,
      cooling: proxies.filter((p) => p.state === "cooling").length,
      quarantined: proxies.filter((p) => p.state === "quarantined").length,
      proxies,
    };
  }
}

// ─── Shared singleton ─────────────────────────────────────────────────────────
// Import { proxyPool } anywhere. Lazily built from env on first import.
export const proxyPool = new ProxyPool();

/**
 * Map an HTTP status / page signal to a proxy outcome.
 * 403/429/503 and Cloudflare-style challenges count as bans (rotate away);
 * everything else 2xx/3xx is success, network throws are errors.
 */
export function classifyOutcome(statusCode: number | null, html?: string): ProxyOutcome {
  if (statusCode && [403, 429, 503, 407].includes(statusCode)) return "ban";
  if (html && /cf-browser-verification|challenge-form|cf_chl_prog|captcha/i.test(html))
    return "ban";
  if (statusCode && statusCode >= 200 && statusCode < 400) return "success";
  if (statusCode && statusCode >= 500) return "error";
  return "success";
}
