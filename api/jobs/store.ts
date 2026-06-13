/**
 * api/jobs/store.ts
 * In-memory job store with automatic TTL cleanup.
 *
 * Jobs are kept for JOB_TTL_MS after completion/failure (default 1 hour).
 * A periodic sweeper runs every 5 minutes.
 */

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

// ── TTL cleanup ───────────────────────────────────────────────────────────────
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

const sweepInterval = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of store.entries()) {
    if (
      (job.status === "completed" || job.status === "failed") &&
      job.updatedAt < cutoff
    ) {
      store.delete(id);
    }
  }
}, 5 * 60 * 1000);

// Allow Node.js to exit even if interval is still registered
sweepInterval.unref();

// ── CRUD ──────────────────────────────────────────────────────────────────────

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

export function updateJob(
  id: string,
  partial: Partial<JobRecord>
): JobRecord | null {
  const job = store.get(id);
  if (!job) return null;
  const updated: JobRecord = { ...job, ...partial, updatedAt: Date.now() };
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
