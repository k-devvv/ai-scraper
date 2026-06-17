/**
 * src/lib/retry.ts
 * Retry with exponential backoff + jitter.
 *
 * Features:
 *   - Configurable max attempts, base delay, max delay
 *   - Full jitter (AWS-style) to avoid thundering herd
 *   - Optional abort signal
 *   - Typed error classification for smarter retries
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "shouldRetry" | "onRetry" | "signal">> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Retry aborted"));
    });
  });
}

/** Full jitter: random(0, min(maxDelay, baseDelay * 2^attempt)) */
function jitteredDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxMs);
  return Math.floor(Math.random() * capped);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_OPTIONS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // Check if we should retry
      if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) {
        throw err;
      }

      // Don't sleep after the last attempt
      if (attempt < maxAttempts - 1) {
        const delay = jitteredDelay(attempt, baseDelayMs, maxDelayMs);
        opts.onRetry?.(err, attempt + 1, delay);
        await sleep(delay, opts.signal);
      }
    }
  }

  throw lastError;
}

// ── Error classification helpers ──────────────────────────────────────────

export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;

  const msg = err.message.toLowerCase();

  // Network errors — always retry
  if (msg.includes("econnreset") || msg.includes("econnrefused")) return true;
  if (msg.includes("etimedout") || msg.includes("esockettimedout")) return true;
  if (msg.includes("fetch failed") || msg.includes("network")) return true;
  if (msg.includes("socket hang up") || msg.includes("enotfound")) return true;

  // HTTP errors — retry on server errors and rate limits
  if (msg.includes("429") || msg.includes("rate limit")) return true;
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;

  // Ollama errors — retry on overload
  if (msg.includes("ollama") && msg.includes("busy")) return true;
  if (msg.includes("model is loading")) return true;

  // Playwright errors — retry on timeout
  if (msg.includes("timeout") && msg.includes("exceeded")) return true;
  if (msg.includes("navigation")) return true;

  // Don't retry on validation errors, 4xx, parse errors
  if (msg.includes("json") && msg.includes("parse")) return false;
  if (msg.includes("schema") || msg.includes("invalid")) return false;
  if (msg.includes("401") || msg.includes("403") || msg.includes("404")) return false;

  // Default: retry
  return true;
}

/** Classify error for reporting */
export type ErrorCategory = "network" | "blocked" | "timeout" | "extraction" | "ollama" | "unknown";

export function classifyError(err: unknown): ErrorCategory {
  if (!(err instanceof Error)) return "unknown";
  const msg = err.message.toLowerCase();

  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("fetch failed"))
    return "network";
  if (msg.includes("403") || msg.includes("429") || msg.includes("cloudflare") || msg.includes("blocked"))
    return "blocked";
  if (msg.includes("timeout") || msg.includes("exceeded") || msg.includes("navigation"))
    return "timeout";
  if (msg.includes("json") || msg.includes("parse") || msg.includes("extract"))
    return "extraction";
  if (msg.includes("ollama") || msg.includes("model"))
    return "ollama";

  return "unknown";
}
