import { FastifyInstance } from "fastify";
import { getJob, deleteJob, listJobs } from "../jobs/store";
import { getResultsByJobId } from "../../src/lib/db";

export async function jobsRoute(fastify: FastifyInstance): Promise<void> {
  // GET /v1/jobs
  fastify.get(
    "/v1/jobs",
    { schema: { description: "List all jobs (newest first)", tags: ["jobs"] } },
    async (_req, reply) => {
      const jobs = await listJobs();
      return reply.send(jobs);
    }
  );

  // GET /v1/jobs/:id
  fastify.get<{ Params: { id: string } }>(
    "/v1/jobs/:id",
    {
      schema: {
        description: "Get job status, result, and error details by ID",
        tags: ["jobs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (req, reply) => {
      const job = await getJob(req.params.id);
      if (!job) {
        return reply.code(404).send({ error: "Job not found", id: req.params.id });
      }
      return reply.send(job);
    }
  );

  // GET /v1/jobs/:id/results — persisted results from SQLite
  fastify.get<{ Params: { id: string } }>(
    "/v1/jobs/:id/results",
    {
      schema: {
        description: "Get persisted results from the database for a completed job",
        tags: ["jobs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (req, reply) => {
      try {
        const results = getResultsByJobId(req.params.id);
        return reply.send({ jobId: req.params.id, count: results.length, results });
      } catch (err) {
        return reply.code(500).send({
          error: "Database error",
          message: (err as Error).message,
        });
      }
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
      const existed = await deleteJob(req.params.id);
      if (!existed) {
        return reply.code(404).send({ error: "Job not found", id: req.params.id });
      }
      return reply.code(204).send();
    }
  );
}
