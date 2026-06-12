import { FastifyInstance } from "fastify";
import { runPipeline } from "../../src/pipeline";
import { createJob } from "../jobs/store.ts";
import { enqueue } from "../jobs/runner.ts";

interface ScrapeBody {
  url: string;
  schema: string;
  model?: string;
  mode?: "cheerio" | "hybrid" | "ai";
  fetchMode?: "auto" | "fast" | "stealth" | "intercept";
}

export async function scrapeRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ScrapeBody }>("/v1/scrape", {
    schema: {
      description: "Scrape a single URL with AI extraction",
      tags: ["scrape"],
      body: {
        type: "object",
        required: ["url", "schema"],
        properties: {
          url: { type: "string" },
          schema: { type: "string" },
          model: { type: "string" },
          mode: { type: "string", enum: ["cheerio", "hybrid", "ai"] },
          fetchMode: { type: "string", enum: ["auto", "fast", "stealth", "intercept"] },
        },
      },
    },
  }, async (req, reply) => {
    const { url, schema, model = "qwen2.5:7b", mode = "hybrid", fetchMode } = req.body;
    const job = createJob("scrape");
    enqueue(job.id, () => runPipeline(url, { schema, model, mode, fetchMode, verbose: false }));
    return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}` });
  });
}
