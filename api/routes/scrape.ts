import { FastifyInstance } from "fastify";
import { runPipeline } from "../../src/pipeline";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";

interface ScrapeBody {
  url: string;
  schema: string;
  model?: string;
  mode?: "cheerio" | "hybrid" | "ai";
  fetchMode?: "auto" | "fast" | "stealth" | "intercept";
}

export async function scrapeRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ScrapeBody }>(
    "/v1/scrape",
    {
      schema: {
        description:
          "Scrape a single URL with AI extraction. Returns a job ID to poll.",
        tags: ["scrape"],
        body: {
          type: "object",
          required: ["url", "schema"],
          properties: {
            url: { type: "string", description: "URL to scrape" },
            schema: {
              type: "string",
              description: "Extraction schema name (see /v1/schemas)",
            },
            model: {
              type: "string",
              default: "qwen2.5:7b",
              description: "Ollama model to use",
            },
            mode: {
              type: "string",
              enum: ["cheerio", "hybrid", "ai"],
              default: "hybrid",
              description: "Extraction mode",
            },
            fetchMode: {
              type: "string",
              enum: ["auto", "fast", "stealth", "intercept"],
              default: "auto",
              description: "Fetch strategy",
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
        fetchMode,
      } = req.body;

      const job = createJob("scrape");
      enqueue(job.id, () =>
        runPipeline(url, { schema, model, mode, fetchMode, verbose: false })
      );

      return reply.code(202).send({
        jobId: job.id,
        status: "queued",
        pollUrl: `/v1/jobs/${job.id}`,
      });
    }
  );
}
