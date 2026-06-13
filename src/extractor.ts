/**
 * extractor.ts
 * Ollama-based extraction engine — 100% local, zero API cost.
 *
 * Design decisions:
 *  - Ollama's `format` param enforces JSON schema at the sampler level
 *    (same guarantee as Claude Tool Use — no prose leakage)
 *  - temperature: 0 for deterministic, repeatable extraction
 *  - 20k char content guard — local models have smaller context windows
 *  - Retries once on JSON parse failure before throwing
 */

import { Ollama } from "ollama";

const MAX_MARKDOWN_CHARS = 40_000; // ~5k tokens — safe for 7B models
const ollama = new Ollama({ host: process.env.OLLAMA_HOST ?? "http://localhost:11434" });

export interface OllamaSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ExtractResult<T = Record<string, unknown>> {
  data: T;
  inputTokens: number;
  outputTokens: number;
  model: string;
  truncated: boolean;
}

export async function extractWithOllama<T = Record<string, unknown>>(
  markdown: string,
  schema: OllamaSchema,
  modelName = "qwen2.5:7b"
): Promise<ExtractResult<T>> {
  let truncated = false;
  let content = markdown;

  if (content.length > MAX_MARKDOWN_CHARS) {
    console.warn(
      `[extractor] Markdown truncated from ${content.length} to ${MAX_MARKDOWN_CHARS} chars`
    );
    content = content.slice(0, MAX_MARKDOWN_CHARS) + "\n\n[... content truncated ...]";
    truncated = true;
  }

  const prompt = `Extract structured information from the webpage content below.
Focus only on the primary content — ignore navigation menus, cookie banners, and unrelated sidebars.
Return a JSON object matching this schema: ${schema.description}

<webpage_content>
${content}
</webpage_content>`;

  const response = await ollama.chat({
    model: modelName,
    format: schema.input_schema,  // Ollama enforces JSON schema at sampler level
    options: { temperature: 0 },
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.message.content.trim();

  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    // Strip any accidental markdown fences and retry once
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(cleaned) as T;
  }

  return {
    data: parsed,
    inputTokens: response.prompt_eval_count ?? 0,
    outputTokens: response.eval_count ?? 0,
    model: response.model,
    truncated,
  };
}
