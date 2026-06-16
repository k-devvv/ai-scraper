import { z, ZodTypeAny } from 'zod';
import { logger } from '../lib/logger';

const MAX_MARKDOWN_CHARS = 12000;

// Known prompt injection patterns
const INJECTION_PATTERNS: [RegExp, string][] = [
  [/ignore\s+(previous|above|prior|all)\s+instructions?/gi, '[REDACTED]'],
  [/\[INST\]|\[\/INST\]/g, ''],
  [/<\/?s>|<\/?sys>/gi, ''],
  [/system\s*:/gi, 'context:'],
  [/human\s*:/gi, 'content:'],
  [/assistant\s*:/gi, 'output:'],
  // JSON injection attempts
  [/"\s*:\s*"[^"]*"\s*,\s*"admin[^"]*"\s*:/gi, '"field": "value",'],
];

export function sanitizeForLLM(markdown: string): string {
  if (!markdown || typeof markdown !== 'string') return '';

  let sanitized = markdown;

  for (const [pattern, replacement] of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  // Hard token cap — prevent context window flooding
  if (sanitized.length > MAX_MARKDOWN_CHARS) {
    logger.debug(
      { originalLength: sanitized.length, cappedLength: MAX_MARKDOWN_CHARS },
      'Markdown truncated for LLM input'
    );
    sanitized = sanitized.slice(0, MAX_MARKDOWN_CHARS) + '\n\n[content truncated]';
  }

  return sanitized;
}

/**
 * Validate LLM output against a Zod schema.
 * Returns { valid: true, data } or { valid: false, errors }.
 */
export function validateExtraction<T extends ZodTypeAny>(
  raw: unknown,
  schema: T
): { valid: true; data: z.infer<T> } | { valid: false; errors: z.ZodIssue[] } {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  logger.warn({ issues: result.error.issues }, 'Extraction output failed schema validation');
  return { valid: false, errors: result.error.issues };
}

/**
 * Calculate confidence score for extracted data.
 * score = (filled_required / total_required) × 0.7
 *       + (filled_optional / total_optional) × 0.3
 */
export function calculateConfidence(
  data: Record<string, unknown>,
  requiredFields: string[],
  optionalFields: string[]
): number {
  if (!data || typeof data !== 'object') return 0;

  const filledRequired = requiredFields.filter(
    (f) => data[f] !== null && data[f] !== undefined && data[f] !== ''
  ).length;

  const filledOptional = optionalFields.filter(
    (f) => data[f] !== null && data[f] !== undefined && data[f] !== ''
  ).length;

  const requiredScore =
    requiredFields.length > 0 ? filledRequired / requiredFields.length : 1;

  const optionalScore =
    optionalFields.length > 0 ? filledOptional / optionalFields.length : 1;

  return Number((requiredScore * 0.7 + optionalScore * 0.3).toFixed(4));
}
