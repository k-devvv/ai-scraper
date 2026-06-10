/**
 * scraper.ts
 * Convenience entry-point — delegates to cli.ts.
 * Use: npx tsx src/scraper.ts <command> [args]
 *
 * Note: import.meta.url is ESM-only and breaks in CommonJS builds.
 * We use require.main === module (CommonJS) which works with tsx.
 */

export { runPipeline } from "./pipeline";
export { crawl } from "./crawler";
export { parseSitemap } from "./sitemap";
export { saveOutput } from "./output";
export { fetchPage } from "./fetcher";
export { htmlToMarkdown } from "./cleaner";

// ─── CLI entry (CommonJS-compatible guard) ────────────────────────────────────
// tsx runs files as CJS modules, so require.main === module is the right check.
// import.meta.url is NOT available in this context and causes TS1470.
if (require.main === module) {
  // Re-invoke as cli.ts so all the command parsing lives in one place
  require("./cli");
}
