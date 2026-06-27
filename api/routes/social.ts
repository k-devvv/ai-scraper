/**
 * api/routes/social.ts
 * Social media scraping endpoints.
 *
 * Twitter/X (public, free via Nitter):
 *   POST /v1/social/twitter/profile   — public profile data
 *   POST /v1/social/twitter/tweets    — recent tweets
 *   POST /v1/social/twitter/search    — search tweets
 *
 * Authenticated (requires imported cookies):
 *   POST /v1/social/scrape            — scrape any authenticated URL
 */

import { FastifyInstance } from "fastify";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";
import {
  scrapeTwitterProfile,
  scrapeTwitterTweets,
  searchTwitter,
  getNitterStatus,
} from "../../src/lib/nitter";
import { scrapeAuthenticated } from "../../src/lib/authenticated-scraper";
import { htmlToMarkdown } from "../../src/cleaner";
import { extractWithOllama } from "../../src/extractor";
import { SCHEMA_MAP } from "../../src/schemas";
import { urlValidationHook } from "../middleware/security";

export async function socialRoute(fastify: FastifyInstance): Promise<void> {

  // ── Twitter/X via Nitter (free, no auth) ───────────────────────────────────

  // POST /v1/social/twitter/profile
  fastify.post<{ Body: { handle: string; proxy?: string } }>(
    "/v1/social/twitter/profile",
    {
      schema: {
        description:
          "Get a public Twitter/X profile — name, bio, follower count, etc. " +
          "Free via Nitter (no Twitter account or API key needed).",
        tags: ["social"],
        body: {
          type: "object",
          required: ["handle"],
          properties: {
            handle: { type: "string", description: "Twitter handle (with or without @)" },
            proxy: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const job = await createJob("scrape");
      enqueue(job.id, () => scrapeTwitterProfile(req.body.handle, req.body.proxy));
      return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}` });
    }
  );

  // POST /v1/social/twitter/tweets
  fastify.post<{ Body: { handle: string; maxTweets?: number; proxy?: string } }>(
    "/v1/social/twitter/tweets",
    {
      schema: {
        description: "Get recent tweets from a public Twitter/X profile (free via Nitter).",
        tags: ["social"],
        body: {
          type: "object",
          required: ["handle"],
          properties: {
            handle: { type: "string" },
            maxTweets: { type: "integer", default: 20, minimum: 1, maximum: 100 },
            proxy: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const job = await createJob("scrape");
      enqueue(job.id, () =>
        scrapeTwitterTweets(req.body.handle, {
          maxTweets: req.body.maxTweets,
          proxy: req.body.proxy,
        })
      );
      return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}` });
    }
  );

  // POST /v1/social/twitter/search
  fastify.post<{ Body: { query: string; maxResults?: number; proxy?: string } }>(
    "/v1/social/twitter/search",
    {
      schema: {
        description: "Search public tweets (free via Nitter).",
        tags: ["social"],
        body: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "Search query" },
            maxResults: { type: "integer", default: 20, minimum: 1, maximum: 100 },
            proxy: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const job = await createJob("scrape");
      enqueue(job.id, () =>
        searchTwitter(req.body.query, {
          maxResults: req.body.maxResults,
          proxy: req.body.proxy,
        })
      );
      return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}` });
    }
  );

  // GET /v1/social/twitter/status — Nitter instance health
  fastify.get(
    "/v1/social/twitter/status",
    {
      schema: {
        description: "Check health of Nitter instances used for Twitter/X scraping",
        tags: ["social"],
      },
    },
    async (_req, reply) => {
      return reply.send({ instances: getNitterStatus() });
    }
  );

  // ── Authenticated scraping (requires cookie session) ───────────────────────

  // POST /v1/social/scrape
  fastify.post<{
    Body: {
      url: string;
      platform: string;
      schema?: string;
      model?: string;
      proxy?: string;
      webhookUrl?: string;
    };
  }>(
    "/v1/social/scrape",
    {
      preHandler: urlValidationHook(),
      schema: {
        description:
          "Scrape an authenticated page using saved cookie sessions. " +
          "Requires a session imported via POST /v1/sessions/import. " +
          "Optionally extract structured data with an AI schema.",
        tags: ["social"],
        body: {
          type: "object",
          required: ["url", "platform"],
          properties: {
            url: { type: "string", description: "Full URL to scrape (e.g. LinkedIn profile URL)" },
            platform: {
              type: "string",
              enum: ["linkedin", "instagram", "facebook", "twitter"],
              description: "Platform the URL belongs to",
            },
            schema: {
              type: "string",
              description: "Optional AI extraction schema (see /v1/schemas). Omit for raw HTML/markdown.",
            },
            model: { type: "string", default: "qwen2.5:7b" },
            proxy: { type: "string" },
            webhookUrl: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { url, platform, schema, model, proxy, webhookUrl } = req.body;

      const job = await createJob("scrape", { webhookUrl });

      enqueue(job.id, async () => {
        const authResult = await scrapeAuthenticated(url, platform, { proxy });

        if (authResult.loginDetected) {
          return {
            url,
            platform,
            authenticated: false,
            loginDetected: true,
            error: `Session expired for ${platform}. Re-import cookies via POST /v1/sessions/import`,
            sessionId: authResult.sessionId,
          };
        }

        // Convert HTML to markdown
        const cleaned = htmlToMarkdown(authResult.html);
        const markdown = cleaned.markdown;

        // If schema provided, run AI extraction
        if (schema) {
          const schemaObj = (SCHEMA_MAP as Record<string, unknown>)[schema];
          if (!schemaObj) {
            return {
              url,
              platform,
              authenticated: true,
              markdown,
              charCount: cleaned.charCount,
              error: `Unknown schema: ${schema}. Available: ${Object.keys(SCHEMA_MAP).join(", ")}`,
            };
          }

          const schemaLookup = (SCHEMA_MAP as Record<string, any>)[schema];
          const aiResult = await extractWithOllama(
            markdown,
            schemaLookup,
            model ?? process.env.DEFAULT_MODEL ?? "qwen2.5:7b"
          );

          return {
            url,
            platform,
            authenticated: true,
            sessionId: authResult.sessionId,
            data: aiResult.data,
            method: "ai",
            inputTokens: aiResult.inputTokens,
            outputTokens: aiResult.outputTokens,
            durationMs: authResult.durationMs,
          };
        }

        // No schema — return markdown
        return {
          url,
          platform,
          authenticated: true,
          sessionId: authResult.sessionId,
          markdown,
          charCount: cleaned.charCount,
          estimatedTokens: cleaned.estimatedTokens,
          durationMs: authResult.durationMs,
        };
      });

      return reply.code(202).send({ jobId: job.id, status: "queued", pollUrl: `/v1/jobs/${job.id}` });
    }
  );
}
