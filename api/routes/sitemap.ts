import { FastifyInstance } from "fastify";
import { runPipeline } from "../../src/pipeline";
import { getSitemapUrlStrings } from "../../src/sitemap";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";

interface SitemapBody {
  url: string;
  schema: string;
  model?: string;
  mode?: "cheerio" | "hybrid" | "ai";
  pathPrefix?: string;
  maxPages?: number;
}

export async function sitemapRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: SitemapBody }>(
    "/v1/sitemap",
    {
      schema: {
        description:
          "Discover URLs from a site's sitemap.xml, then scrape each one. Returns a job ID to poll.",
        tags: ["sitemap"],
        body: {
          type: "object",
          required: ["url", "schema"],
          properties: {
            url: {
              type: "string",
              description: "Site base URL or direct sitemap.xml URL",
            },
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
            pathPrefix: {
              type: "string",
              description: "Filter URLs to only those containing this path prefix (e.g. /blog/)",
            },
            maxPages: {
              type: "integer",
              default: 20,
              description: "Max URLs to scrape from sitemap",
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
        pathPrefix,
        maxPages = parseInt(process.env.DEFAULT_MAX_PAGES ?? "20", 10),
      } = req.body;

      const job = createJob("sitemap");

      enqueue(job.id, async () => {
        const urls = await getSitemapUrlStrings(url, {
          pathPrefix,
          maxUrls: maxPages,
        });

        const results: Array<{
          url: string;
          status: "success" | "error";
          result?: unknown;
          error?: string;
        }> = [];

        for (const pageUrl of urls) {
          try {
            const result = await runPipeline(pageUrl, {
              schema,
              model,
              mode,
              verbose: false,
            });
            results.push({ url: pageUrl, status: "success", result });
          } catch (err) {
            results.push({
              url: pageUrl,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return {
          urlsDiscovered: urls.length,
          success: results.filter((r) => r.status === "success").length,
          failed: results.filter((r) => r.status === "error").length,
          results,
        };
      });

      return reply.code(202).send({
        jobId: job.id,
        status: "queued",
        pollUrl: `/v1/jobs/${job.id}`,
      });
    }
  );
}
