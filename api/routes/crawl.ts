import { FastifyInstance } from "fastify";
import { crawl } from "../../src/crawler";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";
import { urlValidationHook } from "../middleware/security";

interface CrawlBody {
  url: string;
  schema: string;
  model?: string;
  mode?: "cheerio" | "hybrid" | "ai";
  maxDepth?: number;
  maxPages?: number;
  concurrency?: number;
  delayMs?: number;
  resume?: boolean;
  proxy?: string;
  webhookUrl?: string;
}

export async function crawlRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CrawlBody }>(
    "/v1/crawl",
    {
      preHandler: urlValidationHook(),
      schema: {
        description: "Deep BFS crawl from a seed URL. Supports proxy, webhook, and resume.",
        tags: ["crawl"],
        body: {
          type: "object",
          required: ["url", "schema"],
          properties: {
            url: { type: "string" },
            schema: { type: "string" },
            model: { type: "string", default: "qwen2.5:7b" },
            mode: { type: "string", enum: ["cheerio", "hybrid", "ai"], default: "hybrid" },
            maxDepth: { type: "integer", default: 2 },
            maxPages: { type: "integer", default: 20 },
            concurrency: { type: "integer", default: 3 },
            delayMs: { type: "integer", default: 200 },
            resume: { type: "boolean", default: false },
            proxy: { type: "string" },
            webhookUrl: { type: "string" },
          },
        },
        response: { 202: { type: "object", properties: { jobId: { type: "string" }, status: { type: "string" }, pollUrl: { type: "string" } } } },
      },
    },
    async (req, reply) => {
      const { url, schema, model = process.env.DEFAULT_MODEL ?? "qwen2.5:7b", mode = "hybrid", maxDepth = 2, maxPages = 20, concurrency = 3, delayMs = 200, resume = false, proxy, webhookUrl } = req.body;

      const job = await createJob("crawl", { webhookUrl });
      enqueue(job.id, () =>
        crawl(url, { schema, model, mode, maxDepth, maxPages, concurrency, delayMs, resume, proxy, verbose: false })
      );

      return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}` });
    }
  );
}
