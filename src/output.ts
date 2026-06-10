/**
 * output.ts
 * Save scraped data to JSON, CSV, JSONL, or Markdown files.
 */

import * as fs from "fs";
import * as path from "path";

export interface OutputRecord {
  url: string;
  data: Record<string, unknown>;
  confidence: number;
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function saveOutput(
  records: OutputRecord[],
  schema: string,
  formats: string[],
  basePath: string
): Promise<void> {
  if (records.length === 0) {
    console.log("  [output] No records to save.");
    return;
  }

  for (const fmt of formats) {
    const format = fmt.trim().toLowerCase();
    switch (format) {
      case "json":
        saveJson(records, schema, basePath);
        break;
      case "csv":
        saveCsv(records, basePath);
        break;
      case "jsonl":
        saveJsonl(records, basePath);
        break;
      case "md":
      case "markdown":
        saveMarkdown(records, schema, basePath);
        break;
      default:
        console.warn(`  [output] Unknown format "${format}" — skipping.`);
    }
  }
}

// ─── JSON ─────────────────────────────────────────────────────────────────────
function saveJson(records: OutputRecord[], schema: string, basePath: string): void {
  const filePath = `${basePath}.json`;
  const payload = {
    schema,
    exportedAt: new Date().toISOString(),
    totalRecords: records.length,
    avgConfidence: Math.round(
      records.reduce((s, r) => s + r.confidence, 0) / records.length
    ),
    results: records.map((r) => ({
      url: r.url,
      confidence: r.confidence,
      ...r.data,
    })),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`  [output] JSON → ${filePath}`);
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function saveCsv(records: OutputRecord[], basePath: string): void {
  const filePath = `${basePath}.csv`;

  // Collect all unique keys across all records
  const allKeys = new Set<string>(["url", "confidence"]);
  for (const r of records) {
    for (const k of Object.keys(r.data)) {
      allKeys.add(k);
    }
  }
  const headers = [...allKeys];

  const rows: string[] = [headers.map(csvEscape).join(",")];

  for (const r of records) {
    const flat: Record<string, unknown> = { url: r.url, confidence: r.confidence, ...r.data };
    const row = headers.map((h) => {
      const val = flat[h];
      if (val === undefined || val === null) return "";
      if (Array.isArray(val)) return csvEscape(val.join(" | "));
      if (typeof val === "object") return csvEscape(JSON.stringify(val));
      return csvEscape(String(val));
    });
    rows.push(row.join(","));
  }

  fs.writeFileSync(filePath, rows.join("\n"), "utf8");
  console.log(`  [output] CSV → ${filePath}`);
}

// ─── JSONL ────────────────────────────────────────────────────────────────────
function saveJsonl(records: OutputRecord[], basePath: string): void {
  const filePath = `${basePath}.jsonl`;
  const lines = records.map((r) =>
    JSON.stringify({ url: r.url, confidence: r.confidence, ...r.data })
  );
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  console.log(`  [output] JSONL → ${filePath}`);
}

// ─── Markdown ─────────────────────────────────────────────────────────────────
function saveMarkdown(records: OutputRecord[], schema: string, basePath: string): void {
  const filePath = `${basePath}.md`;
  const lines: string[] = [
    `# Scrape Results — ${schema}`,
    `> Exported: ${new Date().toISOString()} | Records: ${records.length}`,
    "",
  ];

  for (const r of records) {
    lines.push(`## ${r.url}`);
    lines.push(`**Confidence:** ${r.confidence}%`);
    lines.push("");

    for (const [key, val] of Object.entries(r.data)) {
      if (Array.isArray(val)) {
        lines.push(`**${key}:**`);
        for (const item of val) {
          lines.push(`- ${typeof item === "object" ? JSON.stringify(item) : item}`);
        }
      } else if (typeof val === "object" && val !== null) {
        lines.push(`**${key}:**`);
        for (const [k, v] of Object.entries(val)) {
          lines.push(`- **${k}:** ${v}`);
        }
      } else {
        lines.push(`**${key}:** ${val}`);
      }
      lines.push("");
    }

    lines.push("---", "");
  }

  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  console.log(`  [output] Markdown → ${filePath}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}
