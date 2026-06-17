import { FastifyInstance } from "fastify";
import { runPipeline } from "../../src/pipeline";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";
import { urlValidationHook } from "../middleware/security";

interface BatchBody {
  urls: string[];
  schema: string;
  model?: string;
  mode?: "cheerio" | "hybrid" | "ai";
  concurrency?: number;
  proxy?: string;
  webhookUrl?: string;
}

export async function batchRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: BatchBody }>(
    "/v1/batch",
    {
      preHandler: urlValidationHook(),
      schema: {
        description: "Scrape multiple URLs with the same schema. Supports proxy and webhook.",
        tags: ["batch"],
        body: {
          type: "object",
          required: ["urls", "schema"],
          properties: {
            urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
            schema: { type: "string" },
            model: { type: "string", default: "qwen2.5:7b" },
            mode: { type: "string", enum: ["cheerio", "hybrid", "ai"], default: "hybrid" },
            concurrency: { type: "integer", default: 2 },
            proxy: { type: "string" },
            webhookUrl: { type: "string" },
          },
        },
        response: { 202: { type: "object", properties: { jobId: { type: "string" }, status: { type: "string" }, pollUrl: { type: "string" }, urlCount: { type: "integer" } } } },
      },
    },
    async (req, reply) => {
      const { urls, schema, model = process.env.DEFAULT_MODEL ?? "qwen2.5:7b", mode = "hybrid", concurrency = 2, proxy, webhookUrl } = req.body;

      const job = await createJob("batch", { webhookUrl });

      enqueue(job.id, async () => {
        const results: Array<{ url: string; status: "success" | "error"; result?: unknown; error?: string }> = [];
        const chunks: string[][] = [];
        for (let i = 0; i < urls.length; i += concurrency) chunks.push(urls.slice(i, i + concurrency));

        for (const chunk of chunks) {
          const chunkResults = await Promise.all(
            chunk.map(async (url) => {
              try {
                const result = await runPipeline(url, { schema, model, mode, proxy, verbose: false });
                return { url, status: "success" as const, result };
              } catch (err) {
                return { url, status: "error" as const, error: err instanceof Error ? err.message : String(err) };
              }
            })
          );
          results.push(...chunkResults);
        }

        return { total: urls.length, success: results.filter((r) => r.status === "success").length, failed: results.filter((r) => r.status === "error").length, results };
      });

      return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}`, urlCount: urls.length });
    }
  );
}
