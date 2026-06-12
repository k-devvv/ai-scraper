import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import { healthRoute } from "./routes/health.ts";
import { schemasRoute } from "./routes/schemas.ts";
import { jobsRoute } from "./routes/jobs.ts";
import { scrapeRoute } from "./routes/scrape.ts";
import { crawlRoute } from "./routes/crawl.ts";
import { batchRoute } from "./routes/batch.ts";
import { sitemapRoute } from "./routes/sitemap.ts";

const API_KEY = process.env.API_KEY;
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

export async function startServer(): Promise<void> {
  const fastify = Fastify({
    logger: {
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "ai-scraper API",
        description: "REST API for ai-scraper — local AI-powered web scraping",
        version: "1.0.0",
      },
      tags: [
        { name: "scrape", description: "Single URL extraction" },
        { name: "crawl", description: "Deep BFS crawl" },
        { name: "batch", description: "Multi-URL batch scrape" },
        { name: "sitemap", description: "Sitemap-driven scrape" },
        { name: "jobs", description: "Job management" },
        { name: "schemas", description: "Available schemas" },
        { name: "system", description: "Health & system info" },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list" },
  });

  await fastify.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    keyGenerator: (req) =>
      (req.headers["x-api-key"] as string) ?? req.ip,
  });

  fastify.addHook("onRequest", async (req, reply) => {
    if (!API_KEY) return;
    const skipPaths = ["/docs", "/v1/health"];
    if (skipPaths.some((p) => req.url.startsWith(p))) return;
    const provided = req.headers["x-api-key"];
    if (!provided || provided !== API_KEY) {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "Missing or invalid X-API-Key header",
      });
    }
  });

  await fastify.register(healthRoute);
  await fastify.register(schemasRoute);
  await fastify.register(jobsRoute);
  await fastify.register(scrapeRoute);
  await fastify.register(crawlRoute);
  await fastify.register(batchRoute);
  await fastify.register(sitemapRoute);

  const shutdown = async (signal: string) => {
    fastify.log.info(`Received ${signal} — shutting down gracefully`);
    await fastify.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Docs available at http://localhost:${PORT}/docs`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

startServer();
