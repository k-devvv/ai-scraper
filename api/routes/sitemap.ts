import { FastifyInstance } from "fastify";
import { runPipeline } from "../../src/pipeline";
import { getSitemapUrlStrings } from "../../src/sitemap";
import { createJob } from "../jobs/store.ts";
import { enqueue } from "../jobs/runner.ts";

interface SitemapBody {
  url: string;
  schema: string;
  model?: string;
  mode?: "cheerio" | "hybrid" | "ai";
  pathPrefix?: string;
  maxPages?: number;
}

export async function sitemapRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: SitemapBody }>("/v1/sitemap", {
    schema: {
      description: "Discover URLs from sitemap and scrape each one",
      tags: ["sitemap"],
      body: {
        type: "object",
        required: ["url", "schema"],
        properties: {
          url: { type: "string" },
          schema: { type: "string" },
          model: { type: "string" },
          mode: { type: "string", enum: ["cheerio", "hybrid", "ai"] },
          pathPrefix: { type: "string" },
          maxPages: { type: "integer", default: 20 },
        },
      },
    },
  }, async (req, reply) => {
    const { url, schema, model = "qwen2.5:7b", mode = "hybrid", pathPrefix, maxPages = 20 } = req.body;
    const job = createJob("sitemap");
    enqueue(job.id, async () => {
      const urls = await getSitemapUrlStrings(url, { pathPrefix, maxUrls: maxPages });
      const results = [];
      for (const pageUrl of urls) {
        try {
          const result = await runPipeline(pageUrl, { schema, model, mode, verbose: false });
          results.push({ url: pageUrl, status: "success", result });
        } catch (err) {
          results.push({ url: pageUrl, status: "error", error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { urlsDiscovered: urls.length, results };
    });
    return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}` });
  });
}
