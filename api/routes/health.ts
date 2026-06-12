import { FastifyInstance } from "fastify";

export async function healthRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/v1/health",
    {
      schema: {
        description: "Health check — includes Ollama reachability",
        tags: ["system"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              ollama: { type: "string" },
              uptime: { type: "number" },
              timestamp: { type: "string" },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const ollamaHost =
        process.env.OLLAMA_HOST ?? "http://localhost:11434";
      let ollamaStatus: "reachable" | "unreachable" = "unreachable";

      try {
        const res = await fetch(`${ollamaHost}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) ollamaStatus = "reachable";
      } catch {
        ollamaStatus = "unreachable";
      }

      return reply.code(200).send({
        status: ollamaStatus === "reachable" ? "ok" : "degraded",
        ollama: ollamaStatus,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    }
  );
}
