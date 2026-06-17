/**
 * api/jobs/webhook.ts
 * Fire-and-forget webhook delivery.
 *
 * Sends a POST with the full job record to the caller's webhookUrl.
 * Retries up to 3 times with exponential backoff on failure.
 * Never throws — webhook failures are logged but don't affect the job.
 */

import type { JobRecord } from "./store";

export async function sendWebhook(url: string, job: JobRecord): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY = 1000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ai-scraper-webhook/3.1",
          "X-Webhook-Event": job.status,
          "X-Job-Id": job.id,
        },
        body: JSON.stringify({
          event: job.status,
          job,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) {
        console.log(`[webhook] Delivered to ${url} (${res.status}) for job ${job.id}`);
        return;
      }

      console.warn(`[webhook] ${url} returned ${res.status} for job ${job.id}`);
    } catch (err) {
      console.warn(
        `[webhook] Attempt ${attempt + 1} failed for ${url}: ${(err as Error).message}`
      );
    }

    // Don't sleep after the last attempt
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, attempt)));
    }
  }

  console.error(`[webhook] All ${MAX_ATTEMPTS} attempts failed for ${url}, job ${job.id}`);
}
