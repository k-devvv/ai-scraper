import { randomUUID } from "crypto";

export type JobType = "scrape" | "crawl" | "batch" | "sitemap";
export type JobStatus = "queued" | "active" | "completed" | "failed";

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const store = new Map<string, JobRecord>();

export function createJob(type: JobType): JobRecord {
  const job: JobRecord = {
    id: randomUUID(),
    type,
    status: "queued",
    progress: 0,
    result: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.set(job.id, job);
  return job;
}

export function updateJob(id: string, partial: Partial<JobRecord>): JobRecord | null {
  const job = store.get(id);
  if (!job) return null;
  const updated = { ...job, ...partial, updatedAt: Date.now() };
  store.set(id, updated);
  return updated;
}

export function getJob(id: string): JobRecord | null {
  return store.get(id) ?? null;
}

export function deleteJob(id: string): boolean {
  return store.delete(id);
}

export function listJobs(): JobRecord[] {
  return Array.from(store.values()).sort((a, b) => b.createdAt - a.createdAt);
}

// TTL cleanup: every 10 minutes, remove completed/failed jobs older than 1 hour
const TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of store.entries()) {
    if (
      (job.status === "completed" || job.status === "failed") &&
      now - job.updatedAt > TTL_MS
    ) {
      store.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS).unref(); // .unref() so it doesn't block process exit
