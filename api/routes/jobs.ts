import { FastifyInstance } from "fastify";
import { getJob, deleteJob, listJobs } from "../jobs/store.ts";

export async function jobsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/jobs", {
    schema: { description: "List all jobs", tags: ["jobs"] },
  }, async (_req, reply) => {
    return reply.send(listJobs());
  });

  fastify.get<{ Params: { id: string } }>("/v1/jobs/:id", {
    schema: {
      description: "Get job by ID",
      tags: ["jobs"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (req, reply) => {
    const job = getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return reply.send(job);
  });

  fastify.delete<{ Params: { id: string } }>("/v1/jobs/:id", {
    schema: {
      description: "Delete a job",
      tags: ["jobs"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (req, reply) => {
    const existed = deleteJob(req.params.id);
    if (!existed) return reply.code(404).send({ error: "Job not found" });
    return reply.code(204).send();
  });
}
