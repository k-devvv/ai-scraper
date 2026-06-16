import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
  base: { service: 'ai-scraper', version: '2.0.0' },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
  },
  redact: {
    // Never log these fields — even if accidentally passed
    paths: ['*.apiKey', '*.password', '*.token', '*.secret', '*.API_KEY'],
    censor: '[REDACTED]',
  },
});

export function createRunLogger(runId: string) {
  return logger.child({ runId });
}
