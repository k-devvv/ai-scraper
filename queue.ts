/**
 * queue.ts — zero ESM-only dependencies
 * Concurrency and retry implemented natively.
 */

export interface ScrapeJob {
  url: string;
  delayMs?: number;
}

export interface ScrapeSuccess<T> {
  url: string;
  status: "success";
  data: T;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface ScrapeError {
  url: string;
  status: "error";
  error: string;
  durationMs: number;
}

export type ScrapeResult<T> = ScrapeSuccess<T> | ScrapeError;

export interface QueueOptions {
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
  label: string
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt <= retries) {
        const wait = delayMs * attempt + Math.random() * 500;
        console.warn(`[queue] Retry ${attempt}/${retries} for ${label} in ${Math.round(wait)}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastError;
}

export async function runQueue<T>(
  jobs: ScrapeJob[],
  handler: (url: string) => Promise<{ data: T; inputTokens: number; outputTokens: number }>,
  opts: QueueOptions = {}
): Promise<ScrapeResult<T>[]> {
  const { concurrency = 3, retries = 2, retryDelayMs = 1500 } = opts;

  const results: ScrapeResult<T>[] = [];
  const queue = [...jobs];
  let active = 0;

  return new Promise((resolve) => {
    function next() {
      while (active < concurrency && queue.length > 0) {
        const job = queue.shift()!;
        active++;

        const start = Date.now();
        const run = async () => {
          if (job.delayMs) await sleep(job.delayMs);
          try {
            const result = await withRetry(
              () => handler(job.url),
              retries,
              retryDelayMs,
              job.url
            );
            results.push({
              url: job.url,
              status: "success",
              data: result.data,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              durationMs: Date.now() - start,
            });
          } catch (err) {
            results.push({
              url: job.url,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - start,
            });
          } finally {
            active--;
            if (queue.length === 0 && active === 0) resolve(results);
            else next();
          }
        };

        run();
      }
    }

    if (jobs.length === 0) return resolve([]);
    next();
  });
}