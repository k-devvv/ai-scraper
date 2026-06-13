/**
 * api/server.ts
 * Fastify REST API server for ai-scraper.
 *
 * Features:
 *   - pino-pretty in dev, structured JSON in prod
 *   - @fastify/rate-limit — 60 req/min per API key or IP
 *   - @fastify/swagger + swagger-ui at /docs
 *   - Optional X-API-Key auth (skip /docs and /v1/health)
 *   - Graceful SIGTERM / SIGINT shutdown
 */

import "dotenv/config";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import { healthRoute } from "./routes/health";
import { schemasRoute } from "./routes/schemas";
import { jobsRoute } from "./routes/jobs";
import { scrapeRoute } from "./routes/scrape";
import { crawlRoute } from "./routes/crawl";
import { batchRoute } from "./routes/batch";
import { sitemapRoute } from "./routes/sitemap";

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
  });

  // ── Swagger / OpenAPI ─────────────────────────────────────────────────────
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "ai-scraper API",
        description:
          "REST API for local AI-powered web scraping via Ollama.\n\n" +
          "All endpoints except `/v1/health` and `/docs` require `X-API-Key` " +
          "when `API_KEY` env var is set.",
        version: "3.0.0",
      },
      tags: [
        { name: "scrape", description: "Single URL extraction" },
        { name: "crawl", description: "Deep BFS crawl" },
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

  // ── Rate limiting ─────────────────────────────────────────────────────────
  await fastify.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    keyGenerator: (req) =>
      ((req.headers["x-api-key"] as string) ?? req.ip) || "unknown",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded. Retry after ${context.after}.`,
    }),
  });

  // ── API key auth hook ─────────────────────────────────────────────────────
  const SKIP_AUTH_PREFIXES = ["/docs", "/v1/health"];

  fastify.addHook("onRequest", async (req, reply) => {
    if (!API_KEY) return; // Auth disabled
    if (SKIP_AUTH_PREFIXES.some((p) => req.url.startsWith(p))) return;
    const provided = req.headers["x-api-key"];
    if (!provided || provided !== API_KEY) {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "Missing or invalid X-API-Key header",
      });
    }
  });

  // ── Routes ────────────────────────────────────────────────────────────────
  await fastify.register(healthRoute);
  await fastify.register(schemasRoute);
  await fastify.register(jobsRoute);
  await fastify.register(scrapeRoute);
  await fastify.register(crawlRoute);
  await fastify.register(batchRoute);
  await fastify.register(sitemapRoute);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info(`Received ${signal} — shutting down gracefully`);
    try {
      await fastify.close();
      fastify.log.info("Server closed cleanly");
      process.exit(0);
    } catch (err) {
      fastify.log.error(err, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ── Start ─────────────────────────────────────────────────────────────────
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(
      `API docs: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/docs`
    );
    fastify.log.info(
      `Health:   http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/v1/health`
    );
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
startServer();
