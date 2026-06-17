/**
 * api/routes/screenshot.ts
 * Capture full-page or viewport screenshots.
 *
 * Inspired by Firecrawl's screenshot feature.
 * Returns base64-encoded PNG/JPEG via the job result.
 */

import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { createJob } from "../jobs/store";
import { enqueue } from "../jobs/runner";
import { saveScreenshot } from "../../src/lib/db";
import { urlValidationHook } from "../middleware/security";

interface ScreenshotBody {
  url: string;
  format?: "png" | "jpeg";
  fullPage?: boolean;
  width?: number;
  height?: number;
  proxy?: string;
  webhookUrl?: string;
}

async function captureScreenshot(
  url: string,
  opts: {
    format?: "png" | "jpeg";
    fullPage?: boolean;
    width?: number;
    height?: number;
    proxy?: string;
  }
): Promise<{ buffer: Buffer; width: number; height: number }> {
  // Dynamic import to avoid loading Playwright when not needed
  const { chromium } = await import("playwright-extra");
  const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
  chromium.use(StealthPlugin());

  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;

  const browser = await (chromium as any).launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    ...(opts.proxy ? { proxy: { server: opts.proxy } } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width, height });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(2000);
    });

    const buffer = await page.screenshot({
      type: opts.format ?? "png",
      fullPage: opts.fullPage ?? false,
      ...(opts.format === "jpeg" ? { quality: 85 } : {}),
    });

    return { buffer: Buffer.from(buffer), width, height };
  } finally {
    await browser.close();
  }
}

export async function screenshotRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ScreenshotBody }>(
    "/v1/screenshot",
    {
      preHandler: urlValidationHook(),
      schema: {
        description: "Capture a screenshot of any URL. Returns base64-encoded image in the job result.",
        tags: ["scrape"],
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
            format: { type: "string", enum: ["png", "jpeg"], default: "png" },
            fullPage: { type: "boolean", default: false },
            width: { type: "integer", default: 1280, minimum: 320, maximum: 3840 },
            height: { type: "integer", default: 720, minimum: 240, maximum: 2160 },
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
      const { url, format, fullPage, width, height, proxy, webhookUrl } = req.body;

      const job = await createJob("screenshot", { webhookUrl });

      enqueue(job.id, async () => {
        const { buffer, width: w, height: h } = await captureScreenshot(url, {
          format,
          fullPage,
          width,
          height,
          proxy,
        });

        const screenshotId = randomUUID();

        // Persist screenshot to SQLite
        try {
          saveScreenshot({
            id: screenshotId,
            job_id: job.id,
            url,
            format: format ?? "png",
            data: buffer,
            width: w,
            height: h,
          });
        } catch (err) {
          console.warn("[db] Failed to persist screenshot:", (err as Error).message);
        }

        return {
          url,
          screenshotId,
          format: format ?? "png",
          width: w,
          height: h,
          sizeBytes: buffer.length,
          base64: buffer.toString("base64"),
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
