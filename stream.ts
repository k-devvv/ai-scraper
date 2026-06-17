import { FastifyInstance } from "fastify";
import { getJob } from "../jobs/store";

/**
 * GET /v1/jobs/:id/stream — Server-Sent Events feed of a job's progress.
 *
 * Clients connect with EventSource and receive `progress`, `done`, and `error`
 * events instead of polling /v1/jobs/:id on a timer. Backed by the existing
 * in-memory store via lightweight polling on the server side, so no store
 * rewrite is needed.
 */
export async function streamRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    "/v1/jobs/:id/stream",
    {
      schema: {
        description: "Stream live job progress via Server-Sent Events.",
        tags: ["jobs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let lastProgress = -1;
      let lastStatus = "";

      const tick = setInterval(() => {
        const job = getJob(id);
        if (!job) {
          send("error", { error: "Job not found" });
          cleanup();
          return;
        }
        if (job.progress !== lastProgress || job.status !== lastStatus) {
          lastProgress = job.progress;
          lastStatus = job.status;
          send("progress", { status: job.status, progress: job.progress });
        }
        if (job.status === "completed") {
          send("done", { status: job.status, result: job.result });
          cleanup();
        } else if (job.status === "failed") {
          send("error", { status: job.status, error: job.error });
          cleanup();
        }
      }, 500);

      // Heartbeat so proxies/load-balancers don't drop an idle connection.
      const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

      const cleanup = () => {
        clearInterval(tick);
        clearInterval(heartbeat);
        reply.raw.end();
      };

      req.raw.on("close", cleanup);
    }
  );
}
