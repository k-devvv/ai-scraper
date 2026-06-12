import PQueue from "p-queue";
import { updateJob } from "./store.ts";

const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);
export const jobQueue = new PQueue({ concurrency });

export function enqueue(jobId: string, fn: () => Promise<unknown>): void {
  jobQueue.add(async () => {
    updateJob(jobId, { status: "active", progress: 0 });
    try {
      const result = await fn();
      updateJob(jobId, { status: "completed", progress: 100, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateJob(jobId, { status: "failed", error: message });
    }
  });
}
