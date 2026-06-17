/**
 * api/server.ts
 * Fastify REST API server for ai-scraper v3.1.
 *
 * Features:
 *   - Security: Helmet (CSP, HSTS), CORS, SSRF prevention, URL validation
 *   - Auth: Optional X-API-Key
 *   - Rate limiting: 60 req/min per key or IP
 *   - Swagger UI at /docs
 *   - Persistent jobs (Redis or in-memory)
 *   - Result persistence (SQLite)
 *   - Retry with exponential backoff
 *   - Webhook callbacks on job completion
 *   - Graceful shutdown (Redis + SQLite cleanup)
 */

import "dotenv/config";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { registerSecurity } from "./middleware/security";
import { closeStore } from "./jobs/store";
import { closeDb } from "../src/lib/db";

// Routes
import { healthRoute } from "./routes/health";
import { schemasRoute } from "./routes/schemas";
import { jobsRoute } from "./routes/jobs";
import { scrapeRoute } from "./routes/scrape";
import { crawlRoute } from "./routes/crawl";
import { batchRoute } from "./routes/batch";
import { sitemapRoute } from "./routes/sitemap";
import { screenshotRoute } from "./routes/screenshot";
import { mapRoute } from "./routes/map";
import { markdownRoute } from "./routes/markdown";

const API_KEY = process.env.API_KEY ?? "";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const IS_PROD = process.env.NODE_ENV === "production";

export async function startServer(): Promise<void> {
  const fastify = Fastify({
    logger: {
      level: "info",
      transport: !IS_PROD
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:HH:MM:ss",
              ignore: "pid,hostname",
            },
          }
        : undefined,
    },
    // Security: limit payload size
    bodyLimit: 1_048_576, // 1MB max request body
  });

  // ── Security middleware ────────────────────────────────────────────────
  await registerSecurity(fastify);

  // ── Swagger / OpenAPI ─────────────────────────────────────────────────
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "ai-scraper API",
        description:
          "Local-first AI web scraping REST API via Ollama.\n\n" +
          "All endpoints except `/v1/health` and `/docs` require `X-API-Key` " +
          "when `API_KEY` env var is set.\n\n" +
          "**Features:** Retry with backoff, webhook callbacks, proxy support, " +
          "screenshot capture, URL discovery, result persistence.",
        version: "3.1.0",
      },
      tags: [
        { name: "scrape", description: "Single URL extraction, screenshots, markdown" },
        { name: "crawl", description: "Deep BFS crawl, URL discovery" },
        { name: "batch", description: "Multi-URL batch scrape" },
        { name: "sitemap", description: "Sitemap-driven scrape" },
        { name: "jobs", description: "Async job management" },
        { name: "schemas", description: "Available extraction schemas" },
        { name: "system", description: "Health and system info" },
      ],
      components: {
        securitySchemes: API_KEY
          ? {
              apiKey: {
                type: "apiKey" as const,
                name: "X-API-Key",
                in: "header" as const,
              },
            }
          : {},
      },
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
    staticCSP: true,
  });

  // ── Rate limiting ─────────────────────────────────────────────────────
  await fastify.register(rateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX ?? "60", 10),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
    keyGenerator: (req) =>
      ((req.headers["x-api-key"] as string) ?? req.ip) || "unknown",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded. Retry after ${context.after}.`,
    }),
  });

  // ── API key auth hook ─────────────────────────────────────────────────
  const SKIP_AUTH_PREFIXES = ["/docs", "/v1/health"];

  fastify.addHook("onRequest", async (req, reply) => {
    if (!API_KEY) return;
    if (SKIP_AUTH_PREFIXES.some((p) => req.url.startsWith(p))) return;
    const provided = req.headers["x-api-key"];
    if (!provided || provided !== API_KEY) {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "Missing or invalid X-API-Key header",
      });
    }
  });

  // ── Request ID header ─────────────────────────────────────────────────
  fastify.addHook("onSend", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
  });

  // ── Routes ────────────────────────────────────────────────────────────
  await fastify.register(healthRoute);
  await fastify.register(schemasRoute);
  await fastify.register(jobsRoute);
  await fastify.register(scrapeRoute);
  await fastify.register(crawlRoute);
  await fastify.register(batchRoute);
  await fastify.register(sitemapRoute);
  await fastify.register(screenshotRoute);
  await fastify.register(mapRoute);
  await fastify.register(markdownRoute);

  // ── Graceful shutdown ─────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info(`Received ${signal} — shutting down gracefully`);
    try {
      await fastify.close();
      await closeStore();
      closeDb();
      fastify.log.info("Server closed cleanly");
      process.exit(0);
    } catch (err) {
      fastify.log.error(err, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ── Start ─────────────────────────────────────────────────────────────
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(
      `API docs: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/docs`
    );
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

startServer();
