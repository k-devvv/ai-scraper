/**
 * security.ts — Hardening helpers for the HTTP API and fetch layer.
 *
 * What this adds on top of the existing sanitize.ts + inline auth hook:
 *   1. timingSafeKeyCheck  — constant-time API-key compare (the current
 *      `provided !== API_KEY` leaks key length/prefix via timing).
 *   2. Multi-key support    — rotate/revoke keys without redeploying.
 *   3. assertPublicUrl      — DNS-resolves the host and re-checks the *resolved*
 *      IPs against private ranges. sanitize.ts only checks the literal hostname,
 *      so `http://evil.com` that resolves to 169.254.169.254 (DNS rebinding)
 *      slips through. This closes that.
 *   4. securityHeaders      — sane default headers without pulling in helmet.
 */

import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// ─── API keys ─────────────────────────────────────────────────────────────────

/** Parse API_KEYS (comma-separated) or fall back to the single API_KEY. */
export function loadApiKeys(): string[] {
  const multi = (process.env.API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const single = (process.env.API_KEY ?? "").trim();
  return single ? [single] : [];
}

/** Constant-time check of a provided key against the allow-list. */
export function timingSafeKeyCheck(provided: unknown, allowed: string[]): boolean {
  if (typeof provided !== "string" || allowed.length === 0) return false;
  const a = Buffer.from(provided);
  // Compare against every key so total time doesn't reveal which matched.
  let ok = false;
  for (const key of allowed) {
    const b = Buffer.from(key);
    const matched = a.length === b.length && crypto.timingSafeEqual(a, b);
    ok = ok || matched;
  }
  return ok;
}

// ─── SSRF: resolve-then-verify ──────────────────────────────────────────────────

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_V4.some((r) => r.test(ip));
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:169.254.") ||
      lower.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

/**
 * Resolve the hostname and reject if ANY resolved address is private/internal.
 * Run this in addition to validateUrl() right before fetching a user-supplied URL.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const { hostname } = new URL(rawUrl);

  // Literal IP in the URL — check directly, no DNS needed.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Blocked private address: ${hostname}`);
    return;
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for: ${hostname}`);
  }
  for (const { address } of records) {
    if (isPrivateIp(address)) {
      throw new Error(`Blocked — ${hostname} resolves to private address ${address} (SSRF)`);
    }
  }
}

// ─── Fastify plugins ────────────────────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

/** Attach baseline security response headers to every reply. */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [h, v] of Object.entries(SECURITY_HEADERS)) reply.header(h, v);
    return payload;
  });
}

/**
 * Build a timing-safe auth hook. Skips the given prefixes (docs, health, the
 * dashboard) and returns a generic 401 with no timing/identity leak.
 */
export function buildAuthHook(skipPrefixes: string[] = ["/docs", "/v1/health", "/dashboard"]) {
  const keys = loadApiKeys();
  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    if (keys.length === 0) return; // open/dev mode
    if (skipPrefixes.some((p) => req.url.startsWith(p))) return;
    const provided = req.headers["x-api-key"];
    if (!timingSafeKeyCheck(provided, keys)) {
      req.log.warn({ ip: req.ip, path: req.url }, "Rejected API request: bad key");
      return reply.code(401).send({ error: "Unauthorized", message: "Missing or invalid X-API-Key" });
    }
  };
}
