/**
 * api/jobs/store.ts
 * Persistent job store — Redis-backed with in-memory fallback.
 *
 * If REDIS_URL is set, jobs persist across restarts.
 * If not, falls back to Map-based store (dev mode).
 *
 * Jobs have a TTL of 24 hours after completion/failure.
 */

import { randomUUID } from "crypto";

export type JobType = "scrape" | "crawl" | "batch" | "sitemap" | "screenshot" | "map";
export type JobStatus = "queued" | "active" | "completed" | "failed";

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  result: unknown;
  error: string | null;
  errorCategory: string | null;
  attempts: number;
  maxAttempts: number;
  webhookUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Redis or in-memory backend ───────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? "";
const JOB_TTL_SECONDS = 24 * 60 * 60; // 24 hours

let redis: import("ioredis").default | null = null;

async function getRedis(): Promise<import("ioredis").default | null> {
  if (!REDIS_URL) return null;
  if (redis) return redis;

  try {
    const Redis = (await import("ioredis")).default;
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    await redis.connect();
    console.log("[store] Connected to Redis");
    return redis;
  } catch (err) {
    console.warn("[store] Redis unavailable, using in-memory store:", (err as Error).message);
    return null;
  }
}

// ── In-memory fallback ───────────────────────────────────────────────────

const memStore = new Map<string, JobRecord>();

const sweepInterval = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_SECONDS * 1000;
  for (const [id, job] of memStore.entries()) {
    if ((job.status === "completed" || job.status === "failed") && job.updatedAt < cutoff) {
      memStore.delete(id);
    }
  }
}, 5 * 60 * 1000);
sweepInterval.unref();

// ── Key helpers ──────────────────────────────────────────────────────────

function jobKey(id: string): string {
  return `job:${id}`;
}

function serialize(job: JobRecord): string {
  return JSON.stringify(job);
}

function deserialize(str: string): JobRecord {
  return JSON.parse(str) as JobRecord;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function createJob(
  type: JobType,
  opts?: { webhookUrl?: string; maxAttempts?: number }
): Promise<JobRecord> {
  const job: JobRecord = {
    id: randomUUID(),
    type,
    status: "queued",
    progress: 0,
    result: null,
    error: null,
    errorCategory: null,
    attempts: 0,
    maxAttempts: opts?.maxAttempts ?? 3,
    webhookUrl: opts?.webhookUrl ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const r = await getRedis();
  if (r) {
    await r.setex(jobKey(job.id), JOB_TTL_SECONDS, serialize(job));
  } else {
    memStore.set(job.id, job);
  }

  return job;
}

export async function updateJob(
  id: string,
  partial: Partial<JobRecord>
): Promise<JobRecord | null> {
  const existing = await getJob(id);
  if (!existing) return null;

  const updated: JobRecord = { ...existing, ...partial, updatedAt: Date.now() };

  const r = await getRedis();
  if (r) {
    await r.setex(jobKey(id), JOB_TTL_SECONDS, serialize(updated));
  } else {
    memStore.set(id, updated);
  }

  return updated;
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const r = await getRedis();
  if (r) {
    const raw = await r.get(jobKey(id));
    return raw ? deserialize(raw) : null;
  }
  return memStore.get(id) ?? null;
}

export async function deleteJob(id: string): Promise<boolean> {
  const r = await getRedis();
  if (r) {
    const deleted = await r.del(jobKey(id));
    return deleted > 0;
  }
  return memStore.delete(id);
}

export async function listJobs(): Promise<JobRecord[]> {
  const r = await getRedis();
  if (r) {
    const keys = await r.keys("job:*");
    if (keys.length === 0) return [];
    const values = await r.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map(deserialize)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  return Array.from(memStore.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function closeStore(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
