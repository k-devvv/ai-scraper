import { FastifyInstance } from "fastify";
import { proxyPool } from "../../src/lib/proxy-pool";

interface ReloadBody {
  proxies: string[];
}

export async function proxiesRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/v1/proxies",
    {
      schema: {
        description: "Live proxy-pool health: per-proxy success rate, latency, ban state.",
        tags: ["proxies"],
      },
    },
    async () => proxyPool.stats()
  );

  fastify.post<{ Body: ReloadBody }>(
    "/v1/proxies/reload",
    {
      schema: {
        description: "Replace the proxy pool at runtime (no restart). Credentials are never returned.",
        tags: ["proxies"],
        body: {
          type: "object",
          required: ["proxies"],
          properties: {
            proxies: {
              type: "array",
              items: { type: "string" },
              description: "Proxy URLs, e.g. http://user:pass@host:port",
            },
          },
        },
      },
    },
    async (req) => {
      proxyPool.load(req.body.proxies);
      return proxyPool.stats();
    }
  );
}
