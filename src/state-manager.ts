/**
 * state-manager.ts — Persistent crawl state (Phase 2b)
 *
 * Problem solved:
 *   Your crawler holds ALL state in memory. If the process dies at page 47
 *   of a 200-page crawl, everything is lost and you start from zero.
 *
 * Solution:
 *   After every FLUSH_EVERY pages, write the full crawl state to disk:
 *     .scraper-state/{url-hash}.json
 *
 *   On next run with --resume, load that state and continue from where
 *   the crawl left off — visited set, queue, and partial results intact.
 *
 * Also writes a crawl-complete.json summary to output/ on finish.
 *
 * Files written:
 *   .scraper-state/{hash}.json   ← live state, flushed every N pages
 *   output/crawl-complete.json   ← final summary on completion
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { CrawlPageResult } from "./crawler";

// How many pages between state flushes
const FLUSH_EVERY = 10;

// Where state files live (relative to cwd)
const STATE_DIR = ".scraper-state";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CrawlState {
  seedUrl: string;
  schema: string;
  startedAt: string;
  lastFlushedAt: string;
  visited: string[];
  queue: Array<[string, number]>;   // [url, depth]
  results: CrawlPageResult[];
  pageCount: number;
}

export interface CrawlSummary {
  seedUrl: string;
  schema: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalPages: number;
  totalSuccess: number;
  totalErrors: number;
  avgConfidence: number;
  resumed: boolean;
}

// ─── StateManager class ───────────────────────────────────────────────────────

export class StateManager {
  private statePath: string;
  private state: CrawlState;
  private flushCounter: number = 0;
  private resumed: boolean = false;

  constructor(seedUrl: string, schema: string) {
    fs.mkdirSync(STATE_DIR, { recursive: true });

    const hash = crypto
      .createHash("md5")
      .update(`${seedUrl}::${schema}`)
      .digest("hex")
      .slice(0, 12);

    this.statePath = path.join(STATE_DIR, `${hash}.json`);

    this.state = {
      seedUrl,
      schema,
      startedAt: new Date().toISOString(),
      lastFlushedAt: new Date().toISOString(),
      visited: [],
      queue: [],
      results: [],
      pageCount: 0,
    };
  }

  // ── Resume ──────────────────────────────────────────────────────────────────

  /**
   * Check if a saved state exists for this seed URL + schema combination.
   */
  canResume(): boolean {
    return fs.existsSync(this.statePath);
  }

  /**
   * Load saved state from disk. Returns the restored state.
   * Call canResume() first.
   */
  resume(): CrawlState {
    const raw = fs.readFileSync(this.statePath, "utf8");
    this.state = JSON.parse(raw) as CrawlState;
    this.resumed = true;
    console.log(
      `[StateManager] Resumed from ${this.statePath}` +
      ` | ${this.state.visited.length} visited | ${this.state.queue.length} queued` +
      ` | ${this.state.results.length} results so far`
    );
    return this.state;
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  getVisited(): Set<string> {
    return new Set(this.state.visited);
  }

  getQueue(): Array<[string, number]> {
    return [...this.state.queue];
  }

  getResults(): CrawlPageResult[] {
    return [...this.state.results];
  }

  getPageCount(): number {
    return this.state.pageCount;
  }

  // ── Mutations (called by crawler on each page) ───────────────────────────────

  recordPage(
    result: CrawlPageResult,
    visited: Set<string>,
    queue: Array<[string, number]>
  ): void {
    this.state.results.push(result);
    this.state.visited = [...visited];
    this.state.queue = [...queue];
    this.state.pageCount++;
    this.flushCounter++;

    if (this.flushCounter >= FLUSH_EVERY) {
      this.flush();
      this.flushCounter = 0;
    }
  }

  // ── Flush ───────────────────────────────────────────────────────────────────

  flush(): void {
    this.state.lastFlushedAt = new Date().toISOString();
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  // ── Complete ─────────────────────────────────────────────────────────────────

  /**
   * Called when crawl finishes. Writes the final summary to output/ and
   * deletes the in-progress state file.
   */
  complete(outputDir: string = "output"): CrawlSummary {
    fs.mkdirSync(outputDir, { recursive: true });

    const successes  = this.state.results.filter((r) => r.status === "success");
    const confs      = successes.map((r) => r.result?.confidence ?? 0).filter((c) => c > 0);
    const avgConf    = confs.length > 0
      ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length)
      : 0;

    const finishedAt = new Date().toISOString();
    const startedAt  = this.state.startedAt;
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    const summary: CrawlSummary = {
      seedUrl:       this.state.seedUrl,
      schema:        this.state.schema,
      startedAt,
      finishedAt,
      durationMs,
      totalPages:    this.state.results.length,
      totalSuccess:  successes.length,
      totalErrors:   this.state.results.length - successes.length,
      avgConfidence: avgConf,
      resumed:       this.resumed,
    };

    // Write summary to output/
    const summaryPath = path.join(outputDir, "crawl-complete.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    console.log(`[StateManager] Summary written → ${summaryPath}`);

    // Delete the in-progress state file — crawl is done
    if (fs.existsSync(this.statePath)) {
      fs.unlinkSync(this.statePath);
    }

    return summary;
  }

  // ── Cleanup (e.g. on SIGINT) ─────────────────────────────────────────────────

  /**
   * Force-flush the current state. Call this in a SIGINT handler so a
   * Ctrl+C doesn't lose the last batch of pages.
   */
  save(): void {
    this.flush();
    console.log(`[StateManager] State saved → ${this.statePath} (${this.state.pageCount} pages)`);
  }

  getStatePath(): string {
    return this.statePath;
  }
}
