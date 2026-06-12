import { FastifyInstance } from "fastify";
import { runPipeline } from "../../src/pipeline";
import { createJob } from "../jobs/store.ts";
import { enqueue } from "../jobs/runner.ts";

interface BatchBody {
  urls: string[];
  schema: string;
  model?: string;
  mode?: "cheerio" | "hybrid" | "ai";
}

export async function batchRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: BatchBody }>("/v1/batch", {
    schema: {
      description: "Scrape multiple URLs with the same schema",
      tags: ["batch"],
      body: {
        type: "object",
        required: ["urls", "schema"],
        properties: {
          urls: { type: "array", items: { type: "string" }, minItems: 1 },
          schema: { type: "string" },
          model: { type: "string" },
          mode: { type: "string", enum: ["cheerio", "hybrid", "ai"] },
        },
      },
    },
  }, async (req, reply) => {
    const { urls, schema, model = "qwen2.5:7b", mode = "hybrid" } = req.body;
    const job = createJob("batch");
    enqueue(job.id, async () => {
      const results = [];
      for (const url of urls) {
        try {
          const result = await runPipeline(url, { schema, model, mode, verbose: false });
          results.push({ url, status: "success", result });
        } catch (err) {
          results.push({ url, status: "error", error: err instanceof Error ? err.message : String(err) });
        }
      }
      return results;
    });
    return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}`, urlCount: urls.length });
  });
}
