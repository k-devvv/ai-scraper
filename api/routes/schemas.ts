import { FastifyInstance } from "fastify";
import { SCHEMA_MAP } from "../../src/schemas";

export async function schemasRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/schemas", {
    schema: {
      description: "List all available extraction schemas",
      tags: ["schemas"],
    },
  }, async (_req, reply) => {
    return reply.send({ schemas: Object.keys(SCHEMA_MAP) });
  });
}
