import { FastifyInstance } from "fastify";
import { crawl } from "../../src/crawler";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";

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
}

export async function crawlRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CrawlBody }>(
    "/v1/crawl",
    {
      schema: {
        description:
          "Start a deep BFS crawl from a seed URL. Returns a job ID to poll.",
        tags: ["crawl"],
        body: {
          type: "object",
          required: ["url", "schema"],
          properties: {
            url: { type: "string", description: "Seed URL to crawl from" },
            schema: {
              type: "string",
              description: "Extraction schema name (see /v1/schemas)",
            },
            model: {
              type: "string",
              default: "qwen2.5:7b",
            },
            mode: {
              type: "string",
              enum: ["cheerio", "hybrid", "ai"],
              default: "hybrid",
            },
            maxDepth: {
              type: "integer",
              default: 2,
              description: "Maximum link-follow depth",
            },
            maxPages: {
              type: "integer",
              default: 20,
              description: "Maximum pages to scrape",
            },
            concurrency: {
              type: "integer",
              default: 3,
              description: "Parallel page fetches",
            },
            delayMs: {
              type: "integer",
              default: 200,
              description: "Delay between requests in ms",
            },
            resume: {
              type: "boolean",
              default: false,
              description: "Resume a previous interrupted crawl",
            },
          },
        },
        response: {
          202: {
            type: "object",
            properties: {
              jobId: { type: "string" },
              status: { type: "string" },
              pollUrl: { type: "string" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const {
        url,
        schema,
        model = process.env.DEFAULT_MODEL ?? "qwen2.5:7b",
        mode = "hybrid",
        maxDepth = parseInt(process.env.DEFAULT_MAX_PAGES ?? "2", 10),
        maxPages = parseInt(process.env.DEFAULT_MAX_PAGES ?? "20", 10),
        concurrency = parseInt(process.env.DEFAULT_CONCURRENCY ?? "3", 10),
        delayMs = parseInt(process.env.DEFAULT_DELAY_MS ?? "200", 10),
        resume = false,
      } = req.body;

      const job = createJob("crawl");
      enqueue(job.id, () =>
        crawl(url, {
          schema,
          model,
          mode,
          maxDepth,
          maxPages,
          concurrency,
          delayMs,
          resume,
          verbose: false,
        })
      );

      return reply.code(202).send({
        jobId: job.id,
        status: "queued",
        pollUrl: `/v1/jobs/${job.id}`,
      });
    }
  );
}
