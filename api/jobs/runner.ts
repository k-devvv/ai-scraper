/**
 * api/jobs/runner.ts
 * Bounded concurrency job queue with retry + webhook dispatch.
 *
 * Uses BullMQ if REDIS_URL is set, otherwise p-queue in-memory.
 */

import PQueue from "p-queue";
import { updateJob, getJob } from "./store";
import { sendWebhook } from "./webhook";
import { withRetry, isRetryableError, classifyError } from "../../src/lib/retry";

const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);
export const jobQueue = new PQueue({ concurrency });

export function enqueue(jobId: string, fn: () => Promise<unknown>): void {
  jobQueue
    .add(async () => {
      await updateJob(jobId, { status: "active", progress: 0 });

      try {
        const result = await withRetry(
          async (attempt) => {
            await updateJob(jobId, { attempts: attempt + 1 });
            return await fn();
          },
          {
            maxAttempts: 3,
            baseDelayMs: 2000,
            maxDelayMs: 30_000,
            shouldRetry: (err, attempt) => {
              if (attempt >= 2) return false; // max 3 attempts (0,1,2)
              return isRetryableError(err);
            },
            onRetry: async (err, attempt, delayMs) => {
              const category = classifyError(err);
              console.warn(
                `[runner] Job ${jobId} attempt ${attempt} failed (${category}), ` +
                `retrying in ${delayMs}ms: ${(err as Error).message}`
              );
              await updateJob(jobId, {
                progress: 0,
                errorCategory: category,
                error: `Retry ${attempt}: ${(err as Error).message}`,
              });
            },
          }
        );

        const job = await updateJob(jobId, {
          status: "completed",
          progress: 100,
          result,
          error: null,
          errorCategory: null,
        });

        // Fire webhook on completion
        if (job?.webhookUrl) {
          await sendWebhook(job.webhookUrl, job);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const category = classifyError(err);

        const job = await updateJob(jobId, {
          status: "failed",
          error: message,
          errorCategory: category,
        });

        // Fire webhook on failure
        if (job?.webhookUrl) {
          await sendWebhook(job.webhookUrl, job);
        }
      }
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, {
        status: "failed",
        error: `Queue error: ${message}`,
        errorCategory: "unknown",
      });
    });
}
