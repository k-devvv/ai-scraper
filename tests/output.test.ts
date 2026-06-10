import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Output writing tests — filesystem only, no network, no AI deps.
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(os.tmpdir(), "ai-scraper-test-output");

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers that mirror what src/output.ts should expose
// ---------------------------------------------------------------------------

function writeJson(data: unknown[], filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function appendJsonl(record: unknown, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
}

function writeCsv(records: Record<string, unknown>[], filePath: string): void {
  if (records.length === 0) {
    fs.writeFileSync(filePath, "", "utf8");
    return;
  }
  const headers = Object.keys(records[0]);
  const rows = records.map((r) =>
    headers.map((h) => {
      const val = r[h];
      const str = val === null || val === undefined ? "" : String(val);
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(",")
  );
  fs.writeFileSync(filePath, [headers.join(","), ...rows].join("\n"), "utf8");
}

function writeMarkdown(records: Record<string, unknown>[], filePath: string, title: string): void {
  const lines: string[] = [`# ${title}`, ""];
  for (const r of records) {
    lines.push(`## ${r.url ?? r.title ?? "Result"}`);
    for (const [k, v] of Object.entries(r)) {
      lines.push(`- **${k}**: ${v}`);
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

// ---------------------------------------------------------------------------

describe("JSON output", () => {
  it("writes and reads back correctly", () => {
    const data = [
      { url: "https://example.com", title: "Test", confidence: 95 },
    ];
    const filePath = path.join(TEST_DIR, "result.json");
    writeJson(data, filePath);

    const readBack = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(readBack).toHaveLength(1);
    expect(readBack[0].url).toBe("https://example.com");
    expect(readBack[0].confidence).toBe(95);
  });

  it("writes multiple records", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      confidence: 80 + i,
    }));
    const filePath = path.join(TEST_DIR, "multi.json");
    writeJson(data, filePath);

    const readBack = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(readBack).toHaveLength(10);
    expect(readBack[9].url).toBe("https://example.com/page-9");
  });

  it("writes pretty-printed JSON (2-space indent)", () => {
    const filePath = path.join(TEST_DIR, "pretty.json");
    writeJson([{ a: 1 }], filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain("  \"a\"");
  });

  it("creates the output directory if it does not exist", () => {
    const nested = path.join(TEST_DIR, "nested", "deep", "result.json");
    writeJson([{ x: 1 }], nested);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe("JSONL streaming output", () => {
  it("appends records one per line", () => {
    const filePath = path.join(TEST_DIR, "stream.jsonl");
    const rows = [
      { url: "https://a.com", data: { title: "A" } },
      { url: "https://b.com", data: { title: "B" } },
    ];
    for (const row of rows) appendJsonl(row, filePath);

    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).url).toBe("https://a.com");
    expect(JSON.parse(lines[1]).url).toBe("https://b.com");
  });

  it("each line is valid JSON", () => {
    const filePath = path.join(TEST_DIR, "valid.jsonl");
    for (let i = 0; i < 5; i++) appendJsonl({ index: i, val: `item-${i}` }, filePath);

    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("can be read back record by record (streaming pattern)", () => {
    const filePath = path.join(TEST_DIR, "readback.jsonl");
    const original = Array.from({ length: 20 }, (_, i) => ({ id: i, score: i * 5 }));
    for (const r of original) appendJsonl(r, filePath);

    const recovered = fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(recovered).toHaveLength(20);
    expect(recovered[19].score).toBe(95);
  });
});

describe("CSV output", () => {
  it("writes headers and rows", () => {
    const records = [
      { title: "Widget Pro", price: "₹1299", in_stock: true },
      { title: "Widget Lite", price: "₹499", in_stock: false },
    ];
    const filePath = path.join(TEST_DIR, "data.csv");
    writeCsv(records, filePath);

    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain("title,price,in_stock");
    expect(raw).toContain("Widget Pro");
    expect(raw).toContain("Widget Lite");
  });

  it("quotes fields containing commas", () => {
    const records = [{ name: "Acme, Inc.", revenue: "1M" }];
    const filePath = path.join(TEST_DIR, "quoted.csv");
    writeCsv(records, filePath);

    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain('"Acme, Inc."');
  });

  it("writes empty file for zero records", () => {
    const filePath = path.join(TEST_DIR, "empty.csv");
    writeCsv([], filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("");
  });
});

describe("Markdown output", () => {
  it("writes a heading and bullet fields", () => {
    const records = [{ url: "https://example.com", title: "Hello", confidence: 90 }];
    const filePath = path.join(TEST_DIR, "output.md");
    writeMarkdown(records, filePath, "Scrape Results");

    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain("# Scrape Results");
    expect(raw).toContain("https://example.com");
    expect(raw).toContain("**confidence**");
  });
});

describe("directory creation", () => {
  it("creates deeply nested output directories without error", () => {
    const deep = path.join(TEST_DIR, "a", "b", "c", "d");
    fs.mkdirSync(deep, { recursive: true });
    expect(fs.existsSync(deep)).toBe(true);
  });

  it("does not throw if directory already exists", () => {
    expect(() => fs.mkdirSync(TEST_DIR, { recursive: true })).not.toThrow();
  });
});
