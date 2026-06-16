import type { Redis } from 'ioredis';
import { redisConnection } from '../queue/index';
import { logger } from '../lib/logger';

const CRAWL_STATE_TTL_SECONDS = 24 * 60 * 60; // 24 hours auto-cleanup

export class CrawlState {
  private redis: Redis;
  private crawlId: string;

  private get visitedKey() { return `crawl:${this.crawlId}:visited`; }
  private get doneKey()    { return `crawl:${this.crawlId}:done`; }
  private get failedKey()  { return `crawl:${this.crawlId}:failed`; }
  private get totalKey()   { return `crawl:${this.crawlId}:total`; }
  private get statusKey()  { return `crawl:${this.crawlId}:status`; }

  constructor(crawlId: string, redis?: Redis) {
    this.crawlId = crawlId;
    this.redis = redis ?? redisConnection;
  }

  /** Returns true if URL was new (not yet visited), false if already queued */
  async markVisited(url: string): Promise<boolean> {
    const added = await this.redis.sadd(this.visitedKey, url);
    return added === 1;
  }

  async isVisited(url: string): Promise<boolean> {
    return (await this.redis.sismember(this.visitedKey, url)) === 1;
  }

  async incrementDone(): Promise<number> {
    return this.redis.incr(this.doneKey);
  }

  async incrementFailed(url: string): Promise<void> {
    await this.redis.sadd(this.failedKey, url);
  }

  async setTotal(total: number): Promise<void> {
    await this.redis.set(this.totalKey, total);
  }

  async setStatus(status: 'running' | 'completed' | 'failed' | 'cancelled'): Promise<void> {
    await this.redis.set(this.statusKey, status);
  }

  async getStatus(): Promise<string | null> {
    return this.redis.get(this.statusKey);
  }

  async getProgress(): Promise<{
    visited: number;
    done: number;
    failed: number;
    total: number;
    status: string | null;
  }> {
    const [visited, done, failed, total, status] = await Promise.all([
      this.redis.scard(this.visitedKey),
      this.redis.get(this.doneKey).then(Number),
      this.redis.scard(this.failedKey),
      this.redis.get(this.totalKey).then(Number),
      this.redis.get(this.statusKey),
    ]);
    return { visited, done, failed, total, status };
  }

  async getFailedUrls(): Promise<string[]> {
    return this.redis.smembers(this.failedKey);
  }

  /** Set TTL on all keys — auto-cleanup after 24h */
  async scheduleCleanup(): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.expire(this.visitedKey, CRAWL_STATE_TTL_SECONDS);
    pipeline.expire(this.doneKey, CRAWL_STATE_TTL_SECONDS);
    pipeline.expire(this.failedKey, CRAWL_STATE_TTL_SECONDS);
    pipeline.expire(this.totalKey, CRAWL_STATE_TTL_SECONDS);
    pipeline.expire(this.statusKey, CRAWL_STATE_TTL_SECONDS);
    await pipeline.exec();
    logger.debug({ crawlId: this.crawlId }, 'Crawl state TTL set');
  }

  /** Force immediate cleanup */
  async cleanup(): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(this.visitedKey);
    pipeline.del(this.doneKey);
    pipeline.del(this.failedKey);
    pipeline.del(this.totalKey);
    pipeline.del(this.statusKey);
    await pipeline.exec();
    logger.info({ crawlId: this.crawlId }, 'Crawl state cleaned up');
  }
}
