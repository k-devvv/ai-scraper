import { logger } from './logger';

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryOn?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown) => void;
}

const DEFAULT_RETRY_STATUS_CODES = [429, 502, 503, 504];

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    maxDelayMs = 15000,
    jitter = true,
    retryOn = (err: any) =>
      DEFAULT_RETRY_STATUS_CODES.includes(err?.response?.status ?? err?.status),
    onRetry,
  } = options;

  let attempt = 0;
  let delay = initialDelayMs;

  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      attempt++;

      if (attempt >= maxAttempts || !retryOn(err)) {
        throw err;
      }

      const jitterMs = jitter ? Math.random() * delay * 0.25 : 0;
      const waitMs = Math.min(delay + jitterMs, maxDelayMs);

      logger.warn(
        { attempt, maxAttempts, waitMs: Math.round(waitMs) },
        'Retrying after error'
      );

      onRetry?.(attempt, err);

      await new Promise((r) => setTimeout(r, waitMs));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  throw new Error('Unreachable — loop exhausted without throwing');
}
