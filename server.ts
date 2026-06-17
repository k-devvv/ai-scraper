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
import fs from "fs";
import path from "path";
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
import { proxiesRoute } from "./routes/proxies";
import { streamRoute } from "./routes/stream";
import { registerSecurityHeaders, buildAuthHook, loadApiKeys } from "../src/lib/security";

const API_KEYS = loadApiKeys();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const IS_PROD = process.env.NODE_ENV === "production";

export async function startServer(): Promise<void> {
  const fastify = Fastify({
    bodyLimit: parseInt(process.env.MAX_BODY_BYTES ?? "1048576", 10), // 1 MiB cap on request bodies
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
        { name: "jobs", description: "Async job management + live SSE streaming" },
        { name: "proxies", description: "Rotating proxy pool health + reload" },
        { name: "schemas", description: "Available extraction schemas" },
        { name: "system", description: "Health and system info" },
      ],
      components: {
        securitySchemes: API_KEYS.length
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

  // ── Security headers + timing-safe API-key auth ───────────────────────────
  registerSecurityHeaders(fastify);
  fastify.addHook("onRequest", buildAuthHook());

  // ── Dashboard (static HTML control panel) ─────────────────────────────────
  fastify.get("/dashboard", async (_req, reply) => {
    const file = path.join(__dirname, "..", "public", "dashboard.html");
    try {
      reply.type("text/html").send(fs.readFileSync(file, "utf8"));
    } catch {
      reply.code(404).send({ error: "Dashboard not found", message: "public/dashboard.html is missing" });
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
  await fastify.register(proxiesRoute);
  await fastify.register(streamRoute);

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
