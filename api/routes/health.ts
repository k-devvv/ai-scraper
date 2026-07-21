import { FastifyInstance } from "fastify";
import { version as pkgVersion } from "../../package.json";

export async function healthRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/v1/health",
    {
      schema: {
        description: "Health check — Ollama, Redis, and SQLite reachability",
        tags: ["system"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              ollama: { type: "string" },
              redis: { type: "string" },
              database: { type: "string" },
              uptime: { type: "number" },
              version: { type: "string" },
              timestamp: { type: "string" },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const ollamaHost = process.env.OLLAMA_HOST ?? "http://localhost:11434";
      let ollamaStatus: "reachable" | "unreachable" = "unreachable";
      let redisStatus: "connected" | "disconnected" | "not_configured" = "not_configured";
      let dbStatus: "ok" | "error" = "ok";

      // Check Ollama
      try {
        const res = await fetch(`${ollamaHost}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) ollamaStatus = "reachable";
      } catch { /* Ollama not running */ }

      // Check Redis
      const redisUrl = process.env.REDIS_URL;
      if (redisUrl) {
        try {
          const Redis = (await import("ioredis")).default;
          const client = new Redis(redisUrl, { connectTimeout: 3000, lazyConnect: true });
          await client.connect();
          await client.ping();
          redisStatus = "connected";
          await client.quit();
        } catch {
          redisStatus = "disconnected";
        }
      }

      // Check SQLite
      try {
        const { getDb } = await import("../../src/lib/db");
        getDb().prepare("SELECT 1").get();
        dbStatus = "ok";
      } catch {
        dbStatus = "error";
      }

      const allHealthy =
        ollamaStatus === "reachable" &&
        (redisStatus === "connected" || redisStatus === "not_configured") &&
        dbStatus === "ok";

      return reply.code(200).send({
        status: allHealthy ? "ok" : "degraded",
        ollama: ollamaStatus,
        redis: redisStatus,
        database: dbStatus,
        uptime: Math.round(process.uptime()),
        version: pkgVersion,
        timestamp: new Date().toISOString(),
      });
    }
  );
}
