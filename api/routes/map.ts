/**
 * api/routes/map.ts
 * Discover all URLs on a website without scraping content.
 *
 * Inspired by Firecrawl's /map endpoint.
 * Combines sitemap parsing + HTML link extraction for comprehensive URL discovery.
 */

import { FastifyInstance } from "fastify";
import axios from "axios";
import * as cheerio from "cheerio";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";
import { urlValidationHook } from "../middleware/security";
import { getSitemapUrlStrings } from "../../src/sitemap";

interface MapBody {
  url: string;
  maxUrls?: number;
  pathPrefix?: string;
  includeSubdomains?: boolean;
  webhookUrl?: string;
}

async function discoverUrls(
  baseUrl: string,
  opts: { maxUrls?: number; pathPrefix?: string; includeSubdomains?: boolean }
): Promise<string[]> {
  const maxUrls = opts.maxUrls ?? 100;
  const urls = new Set<string>();
  const baseHost = new URL(baseUrl).hostname;

  // Strategy 1: Parse sitemap.xml
  try {
    const sitemapUrls = await getSitemapUrlStrings(baseUrl, {
      pathPrefix: opts.pathPrefix,
      maxUrls,
    });
    sitemapUrls.forEach((u) => urls.add(u));
  } catch {
    // No sitemap — fall through to HTML parsing
  }

  // Strategy 2: Crawl HTML links from the landing page
  try {
    const res = await axios.get<string>(baseUrl, {
      timeout: 15_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ai-scraper/3.1; +https://github.com/k-devvv/ai-scraper)",
        Accept: "text/html",
      },
    });

    const $ = cheerio.load(res.data);

    $("a[href]").each((_i, el) => {
      if (urls.size >= maxUrls) return false;

      const href = $(el).attr("href");
      if (!href) return;

      try {
        const resolved = new URL(href, baseUrl);
        if (!["http:", "https:"].includes(resolved.protocol)) return;

        // Same-domain check
        const resolvedHost = resolved.hostname;
        const isSameDomain =
          resolvedHost === baseHost ||
          (opts.includeSubdomains && resolvedHost.endsWith(`.${baseHost}`));

        if (!isSameDomain) return;

        // Path prefix filter
        if (opts.pathPrefix && !resolved.pathname.startsWith(opts.pathPrefix)) return;

        // Strip hash and normalize
        resolved.hash = "";
        urls.add(resolved.toString());
      } catch {
        // Invalid URL — skip
      }
    });
  } catch (err) {
    console.warn(`[map] HTML link extraction failed: ${(err as Error).message}`);
  }

  return Array.from(urls).slice(0, maxUrls).sort();
}

export async function mapRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: MapBody }>(
    "/v1/map",
    {
      preHandler: urlValidationHook(),
      schema: {
        description:
          "Discover all URLs on a website without scraping content. " +
          "Combines sitemap.xml parsing + HTML link extraction.",
        tags: ["crawl"],
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", description: "Site base URL" },
            maxUrls: { type: "integer", default: 100, minimum: 1, maximum: 5000 },
            pathPrefix: { type: "string", description: "Only include URLs under this path" },
            includeSubdomains: { type: "boolean", default: false },
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
      const { url, maxUrls, pathPrefix, includeSubdomains, webhookUrl } = req.body;

      const job = await createJob("map", { webhookUrl });

      enqueue(job.id, async () => {
        const urls = await discoverUrls(url, { maxUrls, pathPrefix, includeSubdomains });
        return { baseUrl: url, totalUrls: urls.length, urls };
      });

      return reply.code(202).send({
        jobId: job.id,
        status: "queued",
        pollUrl: `/v1/jobs/${job.id}`,
      });
    }
  );
}
