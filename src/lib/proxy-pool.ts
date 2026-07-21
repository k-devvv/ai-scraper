/**
 * src/lib/proxy-pool.ts
 * Proxy pool manager — rotates between Tor and any manual proxies.
 *
 * Priority order:
 *   1. Manual proxies (from PROXY_LIST env or API input) — fastest
 *   2. Tor SOCKS5 (free, rotating) — fallback
 *   3. Direct (no proxy) — last resort
 *
 * Usage:
 *   const pool = ProxyPool.getInstance();
 *   const proxy = await pool.next();     // get next proxy URL
 *   pool.markFailed(proxy);              // remove from rotation
 *   pool.markSuccess(proxy);             // reset failure count
 */

import { TorManager, getTorProxy } from "./tor";

export interface ProxyEntry {
  url: string;
  type: "tor" | "http" | "https" | "socks5" | "direct";
  failures: number;
  lastUsed: number;
  lastChecked: number;
  healthy: boolean;
}

const MAX_FAILURES = 3;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 min

export class ProxyPool {
  private static instance: ProxyPool | null = null;
  private proxies: ProxyEntry[] = [];
  private currentIndex = 0;
  private useTor: boolean;

  private constructor() {
    this.useTor = process.env.USE_TOR !== "false";
    this.loadFromEnv();
  }

  static getInstance(): ProxyPool {
    if (!ProxyPool.instance) {
      ProxyPool.instance = new ProxyPool();
    }
    return ProxyPool.instance;
  }

  /** Load proxies from PROXY_LIST env var (comma-separated URLs) */
  private loadFromEnv(): void {
    const list = process.env.PROXY_LIST ?? "";
    if (!list) return;

    const urls = list.split(",").map((s) => s.trim()).filter(Boolean);
    for (const url of urls) {
      this.addProxy(url);
    }
    console.log(`[proxy-pool] Loaded ${urls.length} proxies from PROXY_LIST`);
  }

  /** Add a proxy to the pool at runtime */
  addProxy(url: string): void {
    // Don't add duplicates
    if (this.proxies.some((p) => p.url === url)) return;

    const type = url.startsWith("socks5") || url.startsWith("socks4")
      ? "socks5"
      : url.startsWith("https")
      ? "https"
      : "http";

    this.proxies.push({
      url,
      type,
      failures: 0,
      lastUsed: 0,
      lastChecked: 0,
      healthy: true,
    });
  }

  /** Remove a proxy from the pool */
  removeProxy(url: string): void {
    this.proxies = this.proxies.filter((p) => p.url !== url);
  }

  /** Count of healthy manual proxies currently in rotation */
  healthyCount(): number {
    return this.proxies.filter((p) => p.healthy && p.failures < MAX_FAILURES).length;
  }

  /**
   * Synchronous round-robin over healthy manual proxies only.
   * Used by the fetchPage() lease path, which cannot await Tor bootstrap.
   * Returns null when no manual proxy is available (caller goes direct,
   * or uses Tor via the async next() path / explicit opts.proxy).
   */
  nextSync(): string | null {
    const healthy = this.proxies.filter((p) => p.healthy && p.failures < MAX_FAILURES);
    if (healthy.length === 0) return null;
    const proxy = healthy[this.currentIndex % healthy.length];
    this.currentIndex = (this.currentIndex + 1) % healthy.length;
    proxy.lastUsed = Date.now();
    return proxy.url;
  }

  /** Get the next available proxy URL (round-robin with health filtering) */
  async next(): Promise<string | null> {
    // Try manual proxies first (round-robin)
    const healthy = this.proxies.filter((p) => p.healthy && p.failures < MAX_FAILURES);

    if (healthy.length > 0) {
      const proxy = healthy[this.currentIndex % healthy.length];
      this.currentIndex = (this.currentIndex + 1) % healthy.length;
      proxy.lastUsed = Date.now();
      return proxy.url;
    }

    // Fall back to Tor
    if (this.useTor) {
      const torProxy = await getTorProxy();
      if (torProxy) return torProxy;
    }

    // No proxy available — direct connection
    return null;
  }

  /** Mark a proxy as failed — removes after MAX_FAILURES */
  markFailed(url: string): void {
    const entry = this.proxies.find((p) => p.url === url);
    if (!entry) return;

    entry.failures++;
    if (entry.failures >= MAX_FAILURES) {
      entry.healthy = false;
      console.warn(`[proxy-pool] Proxy ${url} marked unhealthy after ${MAX_FAILURES} failures`);

      // Auto-recover after 10 minutes
      setTimeout(() => {
        entry.failures = 0;
        entry.healthy = true;
        console.log(`[proxy-pool] Proxy ${url} restored to pool`);
      }, 10 * 60 * 1000).unref();
    }
  }

  /** Mark a proxy as healthy */
  markSuccess(url: string): void {
    const entry = this.proxies.find((p) => p.url === url);
    if (!entry) return;
    entry.failures = Math.max(0, entry.failures - 1);
    entry.healthy = true;
  }

  /** Get pool status */
  getStatus(): {
    total: number;
    healthy: number;
    tor: boolean;
    proxies: Array<{ url: string; type: string; healthy: boolean; failures: number }>;
  } {
    return {
      total: this.proxies.length,
      healthy: this.proxies.filter((p) => p.healthy).length,
      tor: this.useTor,
      proxies: this.proxies.map((p) => ({
        url: p.url.replace(/:[^:@]+@/, ":***@"), // mask passwords
        type: p.type,
        healthy: p.healthy,
        failures: p.failures,
      })),
    };
  }

  /** Initialize Tor if enabled */
  async initTor(): Promise<void> {
    if (!this.useTor) return;
    const tor = TorManager.getInstance();
    const running = await tor.isRunning();
    if (!running) {
      console.log("[proxy-pool] Tor not running — starting...");
      await tor.start();
    } else {
      console.log("[proxy-pool] Tor already running");
    }
  }
}

// ─── Fetcher-facing facade ────────────────────────────────────────────────────
// fetchPage() leases a proxy per request and reports the outcome so banned or
// flaky proxies cool down automatically. Kept as a thin wrapper over the
// ProxyPool singleton so the API routes (which use ProxyPool directly) and the
// fetcher share one pool state.

export type ProxyOutcome = "success" | "banned" | "error";

/**
 * Classify a fetch result for proxy health reporting.
 *  - 403 / 429, or block-page markers in the body → "banned"
 *  - 2xx/3xx with normal content                  → "success"
 *  - anything else (5xx, null status, thrown)     → "error"
 */
export function classifyOutcome(statusCode: number | null, html?: string): ProxyOutcome {
  if (statusCode === 403 || statusCode === 429) return "banned";

  if (statusCode !== null && statusCode >= 200 && statusCode < 400) {
    const head = (html ?? "").slice(0, 4000);
    if (/access denied|attention required|are you a (?:human|robot)|captcha|request blocked|unusual traffic/i.test(head)) {
      return "banned";
    }
    return "success";
  }

  return "error";
}

export const proxyPool = {
  /** True when at least one healthy manual proxy is in rotation */
  get enabled(): boolean {
    return ProxyPool.getInstance().healthyCount() > 0;
  },

  /** Lease the next healthy manual proxy (sync round-robin). Null = go direct. */
  acquire(_url: string): string | null {
    return ProxyPool.getInstance().nextSync();
  },

  /** Report the outcome of a leased request back to the pool */
  report(url: string, outcome: ProxyOutcome, _durationMs?: number): void {
    const pool = ProxyPool.getInstance();
    if (outcome === "success") pool.markSuccess(url);
    else pool.markFailed(url);
  },
};
