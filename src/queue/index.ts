import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../lib/config';
import { logger } from '../lib/logger';

// Shared Redis connection (BullMQ requires maxRetriesPerRequest: null)
export const redisConnection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times: number) => Math.min(times * 500, 5000),
});

redisConnection.on('error', (err: Error) => {
  logger.error({ err }, 'Redis connection error');
});

redisConnection.on('connect', () => {
  logger.info({ url: config.REDIS_URL }, 'Redis connected');
});

// Queue definitions
export const scrapeQueue = new Queue('scrape', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export const crawlQueue = new Queue('crawl', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 25 },
  },
});

export const extractQueue = new Queue('extract', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: { count: 200 },
  },
});

// Job data interfaces
export interface ScrapeJobData {
  jobId: string;
  url: string;
  schema: string;
  model?: string;
  outputFormats?: ('json' | 'csv' | 'jsonl' | 'md')[];
  webhookUrl?: string;
  noExtract?: boolean;
}

export interface CrawlJobData extends Omit<ScrapeJobData, 'url'> {
  seedUrl: string;
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  delayMs: number;
  includePattern?: string;
  excludePattern?: string;
}

export interface ExtractJobData {
  jobId: string;
  markdown: string;
  schema: string;
  model: string;
}

// Graceful shutdown
export async function closeQueues() {
  await Promise.all([
    scrapeQueue.close(),
    crawlQueue.close(),
    extractQueue.close(),
  ]);
  await redisConnection.quit();
  logger.info('Queues closed');
}
