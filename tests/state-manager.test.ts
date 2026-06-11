import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Inline StateManager for isolated testing ─────────────────────────────────
// We test the logic directly so tests run without touching the real cwd

const FLUSH_EVERY = 10;

interface CrawlPageResult {
  url: string;
  depth: number;
  status: "success" | "error";
  result?: { confidence: number; data: Record<string, unknown> };
  error?: string;
  durationMs: number;
}

interface CrawlState {
  seedUrl: string;
  schema: string;
  startedAt: string;
  lastFlushedAt: string;
  visited: string[];
  queue: Array<[string, number]>;
  results: CrawlPageResult[];
  pageCount: number;
}

class TestStateManager {
  private statePath: string;
  private stateDir: string;
  private state: CrawlState;
  private flushCounter = 0;
  private resumed = false;

  constructor(seedUrl: string, schema: string, stateDir: string) {
    this.stateDir = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });

    const hash = crypto
      .createHash("md5")
      .update(`${seedUrl}::${schema}`)
      .digest("hex")
      .slice(0, 12);

    this.statePath = path.join(stateDir, `${hash}.json`);
    this.state = {
      seedUrl, schema,
      startedAt: new Date().toISOString(),
      lastFlushedAt: new Date().toISOString(),
      visited: [], queue: [], results: [], pageCount: 0,
    };
  }

  canResume()    { return fs.existsSync(this.statePath); }
  getStatePath() { return this.statePath; }
  getResults()   { return [...this.state.results]; }
  getPageCount() { return this.state.pageCount; }
  getVisited()   { return new Set(this.state.visited); }
  getQueue()     { return [...this.state.queue]; }

  resume(): CrawlState {
    const raw = fs.readFileSync(this.statePath, "utf8");
    this.state = JSON.parse(raw) as CrawlState;
    this.resumed = true;
    return this.state;
  }

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

  flush(): void {
    this.state.lastFlushedAt = new Date().toISOString();
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  complete(outputDir: string): {
    totalSuccess: number; totalErrors: number; avgConfidence: number; resumed: boolean;
  } {
    fs.mkdirSync(outputDir, { recursive: true });
    const successes = this.state.results.filter((r) => r.status === "success");
    const confs     = successes.map((r) => r.result?.confidence ?? 0).filter((c) => c > 0);
    const avgConf   = confs.length > 0
      ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length)
      : 0;

    const summary = {
      seedUrl:      this.state.seedUrl,
      schema:       this.state.schema,
      startedAt:    this.state.startedAt,
      finishedAt:   new Date().toISOString(),
      totalSuccess: successes.length,
      totalErrors:  this.state.results.length - successes.length,
      avgConfidence: avgConf,
      resumed:      this.resumed,
    };

    fs.writeFileSync(
      path.join(outputDir, "crawl-complete.json"),
      JSON.stringify(summary, null, 2),
      "utf8"
    );

    if (fs.existsSync(this.statePath)) fs.unlinkSync(this.statePath);

    return summary;
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeResult(url: string, depth = 0, confidence = 85): CrawlPageResult {
  return {
    url, depth, status: "success",
    result: { confidence, data: { title: "Test" } },
    durationMs: 100,
  };
}

function makeError(url: string, depth = 0): CrawlPageResult {
  return { url, depth, status: "error", error: "timeout", durationMs: 50 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let TEST_DIR: string;
let STATE_DIR: string;
let OUTPUT_DIR: string;

beforeEach(() => {
  TEST_DIR   = fs.mkdtempSync(path.join(os.tmpdir(), "sm-test-"));
  STATE_DIR  = path.join(TEST_DIR, ".scraper-state");
  OUTPUT_DIR = path.join(TEST_DIR, "output");
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe("StateManager — initialisation", () => {
  it("creates state directory on construction", () => {
    new TestStateManager("https://example.com", "product", STATE_DIR);
    expect(fs.existsSync(STATE_DIR)).toBe(true);
  });

  it("canResume() returns false before any flush", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    expect(sm.canResume()).toBe(false);
  });

  it("generates a deterministic state file path for same seed+schema", () => {
    const sm1 = new TestStateManager("https://blog.n8n.io", "saas_ideas", STATE_DIR);
    const sm2 = new TestStateManager("https://blog.n8n.io", "saas_ideas", STATE_DIR);
    expect(sm1.getStatePath()).toBe(sm2.getStatePath());
  });

  it("generates different paths for different schemas", () => {
    const sm1 = new TestStateManager("https://example.com", "product", STATE_DIR);
    const sm2 = new TestStateManager("https://example.com", "article", STATE_DIR);
    expect(sm1.getStatePath()).not.toBe(sm2.getStatePath());
  });

  it("generates different paths for different seed URLs", () => {
    const sm1 = new TestStateManager("https://a.com", "product", STATE_DIR);
    const sm2 = new TestStateManager("https://b.com", "product", STATE_DIR);
    expect(sm1.getStatePath()).not.toBe(sm2.getStatePath());
  });
});

describe("StateManager — recording pages", () => {
  it("records pages and increments pageCount", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set(["https://example.com"]);
    const queue: Array<[string, number]> = [];

    sm.recordPage(makeResult("https://example.com/p1"), visited, queue);
    sm.recordPage(makeResult("https://example.com/p2"), visited, queue);

    expect(sm.getPageCount()).toBe(2);
    expect(sm.getResults()).toHaveLength(2);
  });

  it("records both success and error pages", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [];

    sm.recordPage(makeResult("https://example.com/ok"), visited, queue);
    sm.recordPage(makeError("https://example.com/fail"), visited, queue);

    const results = sm.getResults();
    expect(results.find((r) => r.status === "success")).toBeTruthy();
    expect(results.find((r) => r.status === "error")).toBeTruthy();
  });

  it("does NOT flush to disk before FLUSH_EVERY pages", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [];

    for (let i = 0; i < 9; i++) {
      sm.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    expect(fs.existsSync(sm.getStatePath())).toBe(false);
  });

  it("flushes to disk after exactly FLUSH_EVERY (10) pages", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [];

    for (let i = 0; i < 10; i++) {
      sm.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    expect(fs.existsSync(sm.getStatePath())).toBe(true);
  });

  it("state file contains valid JSON after flush", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [];

    for (let i = 0; i < 10; i++) {
      sm.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    const raw  = fs.readFileSync(sm.getStatePath(), "utf8");
    const parsed = JSON.parse(raw) as CrawlState;
    expect(parsed.pageCount).toBe(10);
    expect(parsed.results).toHaveLength(10);
    expect(parsed.seedUrl).toBe("https://example.com");
  });

  it("persists visited set to state file", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set(["https://example.com/a", "https://example.com/b"]);
    const queue: Array<[string, number]> = [];

    for (let i = 0; i < 10; i++) {
      sm.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    const parsed = JSON.parse(fs.readFileSync(sm.getStatePath(), "utf8")) as CrawlState;
    expect(parsed.visited).toContain("https://example.com/a");
    expect(parsed.visited).toContain("https://example.com/b");
  });

  it("persists queue to state file", () => {
    const sm  = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [
      ["https://example.com/next-1", 1],
      ["https://example.com/next-2", 1],
    ];

    for (let i = 0; i < 10; i++) {
      sm.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    const parsed = JSON.parse(fs.readFileSync(sm.getStatePath(), "utf8")) as CrawlState;
    expect(parsed.queue).toHaveLength(2);
    expect(parsed.queue[0][0]).toBe("https://example.com/next-1");
  });
});

describe("StateManager — resume", () => {
  it("canResume() returns true after a flush", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [];

    for (let i = 0; i < 10; i++) {
      sm.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    expect(sm.canResume()).toBe(true);
  });

  it("resume() restores pageCount from disk", () => {
    const sm1 = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [["https://example.com/queued", 1]];

    for (let i = 0; i < 10; i++) {
      sm1.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    // Simulate new process loading the saved state
    const sm2 = new TestStateManager("https://example.com", "product", STATE_DIR);
    const restored = sm2.resume();

    expect(restored.pageCount).toBe(10);
    expect(restored.results).toHaveLength(10);
  });

  it("resume() restores queue from disk", () => {
    const sm1 = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [["https://example.com/pending", 2]];

    for (let i = 0; i < 10; i++) {
      sm1.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    const sm2 = new TestStateManager("https://example.com", "product", STATE_DIR);
    sm2.resume();
    const restoredQueue = sm2.getQueue();

    expect(restoredQueue[0][0]).toBe("https://example.com/pending");
    expect(restoredQueue[0][1]).toBe(2);
  });

  it("resume() restores visited set from disk", () => {
    const sm1 = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set(["https://example.com/seen-1", "https://example.com/seen-2"]);
    const queue: Array<[string, number]> = [];

    for (let i = 0; i < 10; i++) {
      sm1.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    const sm2 = new TestStateManager("https://example.com", "product", STATE_DIR);
    sm2.resume();
    const restoredVisited = sm2.getVisited();

    expect(restoredVisited.has("https://example.com/seen-1")).toBe(true);
    expect(restoredVisited.has("https://example.com/seen-2")).toBe(true);
  });
});

describe("StateManager — complete()", () => {
  it("writes crawl-complete.json to output dir", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [];

    for (let i = 0; i < 5; i++) {
      sm.recordPage(makeResult(`https://example.com/p${i}`, 0, 90), visited, queue);
    }

    sm.complete(OUTPUT_DIR);

    const summaryPath = path.join(OUTPUT_DIR, "crawl-complete.json");
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    expect(summary.totalSuccess).toBe(5);
    expect(summary.totalErrors).toBe(0);
    expect(summary.avgConfidence).toBe(90);
    expect(summary.seedUrl).toBe("https://example.com");
  });

  it("deletes the in-progress state file after complete()", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [];

    for (let i = 0; i < 10; i++) {
      sm.recordPage(makeResult(`https://example.com/p${i}`), visited, queue);
    }

    expect(fs.existsSync(sm.getStatePath())).toBe(true);
    sm.complete(OUTPUT_DIR);
    expect(fs.existsSync(sm.getStatePath())).toBe(false);
  });

  it("calculates avgConfidence correctly across mixed results", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    const visited = new Set<string>();
    const queue: Array<[string, number]> = [];

    sm.recordPage(makeResult("https://example.com/p1", 0, 100), visited, queue);
    sm.recordPage(makeResult("https://example.com/p2", 0, 80), visited, queue);
    sm.recordPage(makeResult("https://example.com/p3", 0, 60), visited, queue);
    sm.recordPage(makeError("https://example.com/p4"), visited, queue);
    // flush manually since < 10 pages
    sm.flush();

    const summary = sm.complete(OUTPUT_DIR);
    // avg of 100 + 80 + 60 = 240 / 3 = 80
    expect(summary.avgConfidence).toBe(80);
    expect(summary.totalErrors).toBe(1);
    expect(summary.totalSuccess).toBe(3);
  });

  it("resumed flag is false on fresh crawl", () => {
    const sm = new TestStateManager("https://example.com", "product", STATE_DIR);
    sm.flush();
    const summary = sm.complete(OUTPUT_DIR);
    expect(summary.resumed).toBe(false);
  });

  it("resumed flag is true after resume()", () => {
    // First crawl — flush state
    const sm1 = new TestStateManager("https://example.com", "product", STATE_DIR);
    const v = new Set<string>();
    const q: Array<[string, number]> = [];
    for (let i = 0; i < 10; i++) sm1.recordPage(makeResult(`https://example.com/${i}`), v, q);

    // Second crawl — resume
    const sm2 = new TestStateManager("https://example.com", "product", STATE_DIR);
    sm2.resume();
    const summary = sm2.complete(OUTPUT_DIR);
    expect(summary.resumed).toBe(true);
  });
});
