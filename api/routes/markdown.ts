/**
 * api/routes/markdown.ts
 * Convert any URL to clean Markdown — no AI, no Ollama required.
 *
 * Inspired by Firecrawl's /scrape with format: ["markdown"].
 * Uses the fetcher → cleaner → turndown pipeline without AI extraction.
 */

import { FastifyInstance } from "fastify";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";
import { urlValidationHook } from "../middleware/security";
import { fetchPage } from "../../src/fetcher";
import { htmlToMarkdown } from "../../src/cleaner";

interface MarkdownBody {
  url: string;
  fetchMode?: "auto" | "fast" | "stealth" | "intercept";
  proxy?: string;
  webhookUrl?: string;
}

export async function markdownRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: MarkdownBody }>(
    "/v1/markdown",
    {
      preHandler: urlValidationHook(),
      schema: {
        description:
          "Convert any URL to clean Markdown. No AI/Ollama required — pure HTML→Markdown conversion.",
        tags: ["scrape"],
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
            fetchMode: { type: "string", enum: ["auto", "fast", "stealth", "intercept"], default: "auto" },
            proxy: { type: "string" },
            webhookUrl: { type: "string" },
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
      const { url, fetchMode, proxy, webhookUrl } = req.body;

      const job = await createJob("scrape", { webhookUrl });

      enqueue(job.id, async () => {
        const fetchResult = await fetchPage(url, { mode: fetchMode, proxy });
        const markdown = htmlToMarkdown(fetchResult.html);

        return {
          url: fetchResult.finalUrl,
          markdown,
          statusCode: fetchResult.statusCode,
          fetchMode: fetchResult.fetchMode,
          usedFallback: fetchResult.usedFallback,
          durationMs: fetchResult.durationMs,
          contentLength: markdown.length,
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
