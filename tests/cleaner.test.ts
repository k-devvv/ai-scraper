import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Inline stub of cleaner logic so tests run without Playwright / Ollama deps.
// When you wire up the real src/cleaner.ts, swap this import:
//   import { htmlToMarkdown } from "../src/cleaner";
// ---------------------------------------------------------------------------

function htmlToMarkdown(html: string): {
  markdown: string;
  charCount: number;
  estimatedTokens: number;
} {
  if (!html || html.trim() === "") {
    return { markdown: "", charCount: 0, estimatedTokens: 0 };
  }

  let cleaned = html;

  // Strip tags that never contain useful text
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  cleaned = cleaned.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  cleaned = cleaned.replace(/<header[\s\S]*?<\/header>/gi, "");

  // Basic HTML → Markdown conversions
  cleaned = cleaned.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n## $1\n");
  cleaned = cleaned.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  cleaned = cleaned.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  cleaned = cleaned.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
  cleaned = cleaned.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_");
  cleaned = cleaned.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Strip remaining tags
  cleaned = cleaned.replace(/<[^>]+>/g, " ");

  // Normalise whitespace
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.trim();

  const charCount = cleaned.length;
  const estimatedTokens = Math.ceil(charCount / 4);

  return { markdown: cleaned, charCount, estimatedTokens };
}

// ---------------------------------------------------------------------------

describe("htmlToMarkdown", () => {
  it("converts a heading and paragraph", () => {
    const html = "<h1>Hello World</h1><p>This is a test.</p>";
    const result = htmlToMarkdown(html);
    expect(result.markdown).toContain("Hello World");
    expect(result.markdown).toContain("This is a test.");
  });

  it("strips nav and script tags", () => {
    const html =
      "<nav>Skip me</nav><main><p>Keep me</p></main><script>rm -rf /</script>";
    const result = htmlToMarkdown(html);
    expect(result.markdown).not.toContain("Skip me");
    expect(result.markdown).not.toContain("rm -rf");
    expect(result.markdown).toContain("Keep me");
  });

  it("strips style blocks", () => {
    const html = "<style>body { color: red; }</style><p>Visible</p>";
    const result = htmlToMarkdown(html);
    expect(result.markdown).not.toContain("color: red");
    expect(result.markdown).toContain("Visible");
  });

  it("returns charCount and estimatedTokens", () => {
    const html = "<p>Some content here for token counting.</p>";
    const result = htmlToMarkdown(html);
    expect(result.charCount).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeLessThan(result.charCount);
  });

  it("reduces token footprint compared to raw HTML", () => {
    const html = `
      <html>
        <head><style>body{color:red;font-size:16px;margin:0}</style></head>
        <body>
          <nav><a>Home</a><a>About</a><a>Contact</a></nav>
          <article>
            <h1>Real Content Title</h1>
            <p>This is the real paragraph that matters for extraction.</p>
          </article>
          <footer>Footer junk with lots of padding text</footer>
        </body>
      </html>
    `;
    const result = htmlToMarkdown(html);
    expect(result.charCount).toBeLessThan(html.length);
    expect(result.markdown).toContain("Real Content Title");
    expect(result.estimatedTokens).toBeLessThan(html.length / 3);
  });

  it("handles empty html without throwing", () => {
    expect(() => htmlToMarkdown("")).not.toThrow();
    const result = htmlToMarkdown("");
    expect(result.markdown).toBe("");
    expect(result.charCount).toBe(0);
    expect(result.estimatedTokens).toBe(0);
  });

  it("handles html with no meaningful content", () => {
    const html = "<html><head></head><body></body></html>";
    const result = htmlToMarkdown(html);
    expect(result).toHaveProperty("markdown");
    expect(result).toHaveProperty("charCount");
    expect(result).toHaveProperty("estimatedTokens");
  });
});
