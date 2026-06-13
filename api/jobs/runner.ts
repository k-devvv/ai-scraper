/**
 * api/jobs/runner.ts
 * Bounded concurrency job queue using p-queue.
 *
 * WORKER_CONCURRENCY env var controls parallelism (default 2).
 * Keep low (1-2) when jobs hit Ollama; Ollama processes one inference at a time.
 */

import PQueue from "p-queue";
import { updateJob } from "./store";

const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);

export const jobQueue = new PQueue({ concurrency });

export function enqueue(jobId: string, fn: () => Promise<unknown>): void {
  jobQueue
    .add(async () => {
      updateJob(jobId, { status: "active", progress: 0 });
      try {
        const result = await fn();
        updateJob(jobId, { status: "completed", progress: 100, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updateJob(jobId, { status: "failed", error: message });
      }
    })
    .catch((err: unknown) => {
      // PQueue itself can reject (e.g. if queue is paused/cleared)
      const message = err instanceof Error ? err.message : String(err);
      updateJob(jobId, { status: "failed", error: `Queue error: ${message}` });
    });
}
