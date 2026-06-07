/**
 * examples/batch-jobs.ts
 *
 * Shows how to:
 *  1. Scrape multiple job listing URLs in parallel (concurrency = 2)
 *  2. Use a preset schema ("job") with automatic retries
 *  3. Separate successes from errors in the result array
 *
 * Run:  npx tsx examples/batch-jobs.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

// NOTE: adjust the import path if running from a different directory
import { scrapeBatch } from "../src/scraper";
import type { JobData } from "../src/schemas";

const JOB_URLS = [
  "https://jobs.lever.co/anthropic/", // example — swap in real job URLs
];

(async () => {
  console.log(`Scraping ${JOB_URLS.length} job listing(s)...\n`);

  const results = await scrapeBatch<JobData>(JOB_URLS, {
    schema: "job",
    concurrency: 2,
    retries: 2,
    globalDelayMs: 800, // 800ms pause between jobs
  });

  let totalTokens = 0;

  for (const r of results) {
    if (r.status === "success") {
      console.log(`✓ ${r.url} (${r.durationMs}ms)`);
      console.log(JSON.stringify(r.data.result.data, null, 2));
      totalTokens += r.inputTokens + r.outputTokens;
    } else {
      console.error(`✗ ${r.url} → ${r.error}`);
    }
  }

  const successful = results.filter((r) => r.status === "success").length;
  console.log(`\nDone: ${successful}/${results.length} succeeded | Total tokens: ${totalTokens}`);
})();
