import { FastifyInstance } from "fastify";
import { crawl } from "../../src/crawler";
import { createJob } from "../jobs/store.ts";
import { enqueue } from "../jobs/runner.ts";

interface CrawlBody {
  url: string;
  schema: string;
  model?: string;
  mode?: "cheerio" | "hybrid" | "ai";
  maxDepth?: number;
  maxPages?: number;
  concurrency?: number;
  delayMs?: number;
}

export async function crawlRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CrawlBody }>("/v1/crawl", {
    schema: {
      description: "Deep BFS crawl from a seed URL",
      tags: ["crawl"],
      body: {
        type: "object",
        required: ["url", "schema"],
        properties: {
          url: { type: "string" },
          schema: { type: "string" },
          model: { type: "string" },
          mode: { type: "string", enum: ["cheerio", "hybrid", "ai"] },
          maxDepth: { type: "integer", default: 2 },
          maxPages: { type: "integer", default: 20 },
          concurrency: { type: "integer", default: 3 },
          delayMs: { type: "integer", default: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { url, schema, model = "qwen2.5:7b", mode = "hybrid", maxDepth = 2, maxPages = 20, concurrency = 3, delayMs = 200 } = req.body;
    const job = createJob("crawl");
    enqueue(job.id, () => crawl(url, { schema, model, mode, maxDepth, maxPages, concurrency, delayMs, verbose: false }));
    return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}` });
  });
}
