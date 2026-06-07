/**
 * cleaner.ts
 * Converts raw HTML to a clean, token-efficient Markdown string.
 *
 * Why this matters for LLM extraction:
 *  - Stripping <script>, <style>, <nav> etc. can cut token count by 60–80%
 *  - Less token noise → higher extraction accuracy → lower API cost
 *  - Turndown preserves semantic structure (headings, lists, tables) that
 *    Claude uses as signals during structured extraction
 */

import TurndownService from "turndown";
// @ts-ignore — no official types for turndown-plugin-gfm
import * as turndownPluginGfm from "turndown-plugin-gfm";

// Tags to completely remove before Markdown conversion
const NOISE_TAGS = [
  "script",
  "style",
  "noscript",
  "nav",
  "footer",
  "header",
  "aside",
  "iframe",
  "svg",
  "canvas",
  "video",
  "audio",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "meta",
  "link",
];

export interface CleanResult {
  markdown: string;
  charCount: number;
  /** Approximate token estimate (chars / 4) */
  estimatedTokens: number;
}

export function htmlToMarkdown(html: string): CleanResult {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    hr: "---",
    bulletListMarker: "-",
  });

  // Enable GitHub-Flavored Markdown tables (critical for e-commerce/pricing pages)
  td.use(turndownPluginGfm.gfm);

  // Remove all noisy elements in one pass
  td.remove(NOISE_TAGS);

  // Custom rule: collapse whitespace-only table cells
  td.addRule("cleanTableCells", {
    filter: ["td", "th"],
    replacement: (content) => ` ${content.trim()} |`,
  });

  // Custom rule: strip empty links (anchor-only nav debris)
  td.addRule("stripEmptyLinks", {
    filter: (node) =>
      node.nodeName === "A" &&
      !node.textContent?.trim(),
    replacement: () => "",
  });

  const markdown = td
    .turndown(html)
    // Collapse 3+ consecutive blank lines → 2 (reduce whitespace token waste)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    markdown,
    charCount: markdown.length,
    estimatedTokens: Math.ceil(markdown.length / 4),
  };
}
