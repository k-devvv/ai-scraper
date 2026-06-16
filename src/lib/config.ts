/**
 * Centralized config — single source of truth for all env vars.
 * Import config from here instead of reading process.env directly anywhere.
 */
import { z } from 'zod';

// Parse and validate all env vars at startup. Hard crash if required vars missing.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3002),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Ollama — required
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen2.5:7b'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().default(60000),

  // Redis — optional (BullMQ queue, rate limiting)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // API security — optional (if set, all HTTP API requests require X-API-Key)
  API_KEY: z.string().optional(),

  // Scraper limits
  MAX_CONCURRENCY: z.coerce.number().min(1).max(10).default(3),
  MAX_PAGES: z.coerce.number().min(1).max(500).default(50),
  MAX_DEPTH: z.coerce.number().min(1).max(10).default(3),
  PAGE_TIMEOUT_MS: z.coerce.number().default(30000),
  REQUEST_DELAY_MS: z.coerce.number().default(500),

  // Output
  OUTPUT_DIR: z.string().default('./output'),
});

function loadConfig() {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    result.error.issues.forEach((issue) => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();

export type Config = typeof config;
