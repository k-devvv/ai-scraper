import { FastifyInstance } from "fastify";
import { getJob, deleteJob, listJobs } from "../jobs/store";

export async function jobsRoute(fastify: FastifyInstance): Promise<void> {
  // GET /v1/jobs
  fastify.get(
    "/v1/jobs",
    { schema: { description: "List all jobs (newest first)", tags: ["jobs"] } },
    async (_req, reply) => {
      return reply.send(listJobs());
    }
  );

  // GET /v1/jobs/:id
  fastify.get<{ Params: { id: string } }>(
    "/v1/jobs/:id",
    {
      schema: {
        description: "Get job status and result by ID",
        tags: ["jobs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (req, reply) => {
      const job = getJob(req.params.id);
      if (!job) {
        return reply.code(404).send({ error: "Job not found", id: req.params.id });
      }
      return reply.send(job);
    }
  );

  // DELETE /v1/jobs/:id
  fastify.delete<{ Params: { id: string } }>(
    "/v1/jobs/:id",
    {
      schema: {
        description: "Delete a completed or failed job",
        tags: ["jobs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (req, reply) => {
      const existed = deleteJob(req.params.id);
      if (!existed) {
        return reply.code(404).send({ error: "Job not found", id: req.params.id });
      }
      return reply.code(204).send();
    }
  );
}
