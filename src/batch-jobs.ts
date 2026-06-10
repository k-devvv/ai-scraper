/**
 * batch-jobs.ts
 *
 * Shows how to:
 * 1. Scrape multiple job listing URLs in parallel (concurrency = 2)
 * 2. Use a preset schema ("job") with automatic retries
 * 3. Separate successes from errors in the result array
 *
 * Run: npx tsx src/batch-jobs.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { runPipeline } from "./pipeline";
import type { PipelineResult } from "./pipeline";
import pLimit from "p-limit";

const JOB_URLS = [
  "https://jobs.lever.co/anthropic/", // swap in real job URLs
];

// ─── Batch result type ────────────────────────────────────────────────────────

interface BatchResult {
  url: string;
  status: "success" | "error";
  result?: PipelineResult;
  error?: string;
  durationMs: number;
}

// ─── Batch scrape helper ──────────────────────────────────────────────────────

async function scrapeBatch(
  urls: string[],
  opts: { schema: string; concurrency?: number; delayMs?: number }
): Promise<BatchResult[]> {
  const limit   = pLimit(opts.concurrency ?? 2);
  const delayMs = opts.delayMs ?? 800;

  const tasks = urls.map((url) =>
    limit(async (): Promise<BatchResult> => {
      const start = Date.now();
      try {
        const result = await runPipeline(url, { schema: opts.schema, mode: "hybrid" });
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        return { url, status: "success", result, durationMs: Date.now() - start };
      } catch (err) {
        return {
          url,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        };
      }
    })
  );

  return Promise.all(tasks);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`Scraping ${JOB_URLS.length} job listing(s)...\n`);

  const results = await scrapeBatch(JOB_URLS, {
    schema: "job",
    concurrency: 2,
    delayMs: 800,
  });

  for (const r of results) {
    if (r.status === "success" && r.result) {
      console.log(`✓ ${r.url} (${r.durationMs}ms | confidence: ${r.result.confidence}%)`);
      console.log(JSON.stringify(r.result.data, null, 2));
    } else {
      console.error(`✗ ${r.url} → ${r.error}`);
    }
  }

  // ← fixed: explicit BatchResult type on filter param (TS7006)
  const successful = results.filter((r: BatchResult) => r.status === "success").length;
  console.log(`\nDone: ${successful}/${results.length} succeeded`);
})();
