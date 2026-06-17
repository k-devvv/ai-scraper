import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { runPipeline } from "../../src/pipeline";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";
import { saveResult } from "../../src/lib/db";
import { urlValidationHook } from "../middleware/security";

interface ScrapeBody {
  url: string;
  schema: string;
  model?: string;
  mode?: "cheerio" | "hybrid" | "ai";
  fetchMode?: "auto" | "fast" | "stealth" | "intercept";
  proxy?: string;
  webhookUrl?: string;
  maxRetries?: number;
}

export async function scrapeRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ScrapeBody }>(
    "/v1/scrape",
    {
      preHandler: urlValidationHook(),
      schema: {
        description:
          "Scrape a single URL with AI extraction. Returns a job ID to poll. " +
          "Optionally set webhookUrl to receive a POST callback when the job completes.",
        tags: ["scrape"],
        body: {
          type: "object",
          required: ["url", "schema"],
          properties: {
            url: { type: "string", description: "URL to scrape" },
            schema: { type: "string", description: "Extraction schema name (see /v1/schemas)" },
            model: { type: "string", default: "qwen2.5:7b", description: "Ollama model" },
            mode: { type: "string", enum: ["cheerio", "hybrid", "ai"], default: "hybrid" },
            fetchMode: { type: "string", enum: ["auto", "fast", "stealth", "intercept"], default: "auto" },
            proxy: { type: "string", description: "Proxy URL (http/https/socks5)" },
            webhookUrl: { type: "string", description: "URL to POST job result on completion/failure" },
            maxRetries: { type: "integer", default: 3, minimum: 1, maximum: 5, description: "Max retry attempts on transient failure" },
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
        proxy,
        webhookUrl,
        maxRetries = 3,
      } = req.body;

      const job = await createJob("scrape", { webhookUrl, maxAttempts: maxRetries });

      enqueue(job.id, async () => {
        const result = await runPipeline(url, {
          schema,
          model,
          mode,
          fetchMode,
          proxy,
          verbose: false,
        });

        // Persist result to SQLite
        try {
          saveResult({
            id: randomUUID(),
            job_id: job.id,
            job_type: "scrape",
            url,
            schema_name: schema,
            model,
            mode,
            status: "success",
            data: JSON.stringify(result.data),
            error: null,
            confidence: result.confidence,
            method: result.method,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            fetch_ms: result.fetchMs,
            extract_ms: result.extractMs,
            total_ms: result.totalMs,
            truncated: result.truncated ? 1 : 0,
          });
        } catch (err) {
          console.warn("[db] Failed to persist result:", (err as Error).message);
        }

        return result;
      });

      return reply.code(202).send({
        jobId: job.id,
        status: "queued",
        pollUrl: `/v1/jobs/${job.id}`,
      });
    }
  );
}
