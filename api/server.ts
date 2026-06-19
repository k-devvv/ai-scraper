/**
 * api/server.ts — Phase 3c/3d: Nitter + authenticated sessions
 */

import "dotenv/config";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { registerSecurity } from "./middleware/security";
import { closeStore } from "./jobs/store";
import { closeDb } from "../src/lib/db";
import { ProxyPool } from "../src/lib/proxy-pool";

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
import { proxyRoute } from "./routes/proxy";
import { sessionsRoute } from "./routes/sessions";
import { socialRoute } from "./routes/social";

const API_KEY = process.env.API_KEY ?? "";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const IS_PROD = process.env.NODE_ENV === "production";

export async function startServer(): Promise<void> {
  const fastify = Fastify({
    logger: {
      level: "info",
      transport: !IS_PROD
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } }
        : undefined,
    },
    bodyLimit: 1_048_576,
  });

  await registerSecurity(fastify);

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "ai-scraper API",
        description:
          "Local-first AI web scraping with TLS fingerprint spoofing, Tor IP rotation, " +
          "Nitter-based Twitter/X scraping, and authenticated social media sessions.",
        version: "3.3.0",
      },
      tags: [
        { name: "scrape", description: "Single URL extraction, screenshots, markdown" },
        { name: "crawl", description: "Deep BFS crawl, URL discovery" },
        { name: "batch", description: "Multi-URL batch scrape" },
        { name: "sitemap", description: "Sitemap-driven scrape" },
        { name: "social", description: "Twitter/X (Nitter) + authenticated social scraping" },
        { name: "sessions", description: "Cookie session management for authenticated scraping" },
        { name: "jobs", description: "Async job management" },
        { name: "schemas", description: "Extraction schemas" },
        { name: "system", description: "Health, proxy pool, system info" },
      ],
      components: {
        securitySchemes: API_KEY
          ? { apiKey: { type: "apiKey" as const, name: "X-API-Key", in: "header" as const } }
          : {},
      },
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
    staticCSP: true,
  });

  await fastify.register(rateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX ?? "60", 10),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
    keyGenerator: (req) => ((req.headers["x-api-key"] as string) ?? req.ip) || "unknown",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded. Retry after ${context.after}.`,
    }),
  });

  const SKIP_AUTH = ["/docs", "/v1/health"];
  fastify.addHook("onRequest", async (req, reply) => {
    if (!API_KEY) return;
    if (SKIP_AUTH.some((p) => req.url.startsWith(p))) return;
    const provided = req.headers["x-api-key"];
    if (!provided || provided !== API_KEY) {
      return reply.code(401).send({ error: "Unauthorized", message: "Missing or invalid X-API-Key" });
    }
  });

  fastify.addHook("onSend", async (req, reply) => { reply.header("X-Request-Id", req.id); });

  // ── Routes ─────────────────────────────────────────────────────────────────
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
  await fastify.register(proxyRoute);
  await fastify.register(sessionsRoute);
  await fastify.register(socialRoute);

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info(`Received ${signal} — shutting down`);
    try {
      await fastify.close();
      await closeStore();
      closeDb();
      process.exit(0);
    } catch (err) {
      fastify.log.error(err);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Docs: http://localhost:${PORT}/docs`);

    const pool = ProxyPool.getInstance();
    pool.initTor().catch((err) => {
      fastify.log.warn(`[tor] Init failed: ${(err as Error).message}`);
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

startServer();
