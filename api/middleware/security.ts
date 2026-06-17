/**
 * api/middleware/security.ts
 * Security middleware: CORS, Helmet, input validation, URL sanitization.
 *
 * Covers OWASP Top 10 for API security:
 *   - Injection prevention (URL validation, input sanitization)
 *   - Security headers (Helmet — CSP, HSTS, X-Frame-Options)
 *   - CORS restrictiveness
 *   - Rate limiting (handled by @fastify/rate-limit in server.ts)
 *   - Authentication (API key in server.ts)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";

// ── URL validation ───────────────────────────────────────────────────────

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::]",
  "[::1]",
  "metadata.google.internal",
  "169.254.169.254", // AWS/GCP metadata
  "100.100.100.200", // Alibaba metadata
]);

const BLOCKED_PROTOCOLS = new Set(["file:", "ftp:", "data:", "javascript:"]);

export function validateUrl(url: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(url);

    // Protocol check
    if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
      return { valid: false, reason: `Blocked protocol: ${parsed.protocol}` };
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { valid: false, reason: `Only http/https allowed, got: ${parsed.protocol}` };
    }

    // SSRF prevention — block internal/metadata IPs
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(hostname)) {
      return { valid: false, reason: `Blocked host: ${hostname}` };
    }

    // Block private IP ranges
    if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) {
      return { valid: false, reason: "Private IP range blocked (SSRF prevention)" };
    }
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
      return { valid: false, reason: "Private IP range blocked (SSRF prevention)" };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: "Malformed URL" };
  }
}

// ── Input sanitization ───────────────────────────────────────────────────

/** Strip control characters and limit string length */
export function sanitizeString(input: string, maxLength = 2048): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, maxLength);
}

/** Validate and sanitize a proxy URL */
export function validateProxyUrl(proxy: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(proxy);
    if (!["http:", "https:", "socks4:", "socks5:"].includes(parsed.protocol)) {
      return { valid: false, reason: `Invalid proxy protocol: ${parsed.protocol}` };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: "Malformed proxy URL" };
  }
}

// ── URL validation hook (attach to routes) ───────────────────────────────

export function urlValidationHook() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) return;

    // Validate single URL
    if (typeof body.url === "string") {
      const check = validateUrl(body.url);
      if (!check.valid) {
        return reply.code(400).send({
          error: "Invalid URL",
          message: check.reason,
          url: body.url,
        });
      }
    }

    // Validate URL array (batch)
    if (Array.isArray(body.urls)) {
      for (const url of body.urls) {
        if (typeof url !== "string") continue;
        const check = validateUrl(url);
        if (!check.valid) {
          return reply.code(400).send({
            error: "Invalid URL in array",
            message: check.reason,
            url,
          });
        }
      }
    }

    // Validate proxy URL
    if (typeof body.proxy === "string" && body.proxy) {
      const check = validateProxyUrl(body.proxy);
      if (!check.valid) {
        return reply.code(400).send({
          error: "Invalid proxy URL",
          message: check.reason,
        });
      }
    }

    // Validate webhookUrl
    if (typeof body.webhookUrl === "string" && body.webhookUrl) {
      const check = validateUrl(body.webhookUrl);
      if (!check.valid) {
        return reply.code(400).send({
          error: "Invalid webhook URL",
          message: check.reason,
        });
      }
    }
  };
}

// ── Register security plugins ────────────────────────────────────────────

export async function registerSecurity(fastify: FastifyInstance): Promise<void> {
  // Helmet — security headers
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Swagger UI needs inline scripts
        styleSrc: ["'self'", "'unsafe-inline'"],   // Swagger UI needs inline styles
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // breaks Swagger UI
  });

  // CORS
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
    : ["*"];

  await fastify.register(cors, {
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-API-Key", "Authorization"],
    exposedHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
    credentials: false,
    maxAge: 86400, // 24h preflight cache
  });
}
