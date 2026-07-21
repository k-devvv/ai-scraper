/**
 * nl-schema.ts
 * Natural-language → JSON Schema, fully local via Ollama.
 *
 * Lets a user describe what they want in plain English —
 *   --extract "product name, price, and whether it's in stock"
 * — and get a valid OllamaSchema back, no preset required.
 *
 * Design:
 *  - One cheap LLM call generates a JSON Schema (draft-07 subset that
 *    Ollama's `format` param accepts: object with typed properties).
 *  - temperature 0 for determinism; the schema for a given phrase is stable.
 *  - Output is validated and repaired before use — a malformed schema would
 *    otherwise poison every extraction that follows.
 *  - Snake_case field names are enforced so downstream output.ts (CSV headers,
 *    JSONL keys) stays clean.
 */

import { Ollama } from "ollama";
import type { OllamaSchema } from "./extractor";

const ollama = new Ollama({ host: process.env.OLLAMA_HOST ?? "http://localhost:11434" });

/** JSON-Schema-of-a-JSON-Schema — constrains the generator's own output. */
const META_SCHEMA = {
  type: "object",
  properties: {
    properties: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["string", "number", "boolean", "array"],
          },
          items: {
            type: "object",
            properties: { type: { type: "string" } },
          },
          description: { type: "string" },
        },
        required: ["type"],
      },
    },
    required: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["properties", "required"],
} as const;

const SNAKE = /^[a-z][a-z0-9_]*$/;

function toSnake(key: string): string {
  return key
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .toLowerCase();
}

interface GeneratedSchema {
  properties: Record<string, { type: string; items?: { type: string }; description?: string }>;
  required: string[];
}

/**
 * Generate an OllamaSchema from a plain-English field description.
 * Throws only if the model is unreachable or returns unrepairable output.
 */
export async function schemaFromDescription(
  description: string,
  modelName = "qwen2.5:7b"
): Promise<OllamaSchema> {
  const prompt = `You are a schema designer. Convert the user's request into a JSON object describing the fields to extract from a webpage.

Rules:
- Each field goes in "properties" with a "type": one of string, number, boolean, array.
- For array fields, include "items": { "type": "string" } (or number/boolean).
- Use snake_case field names (e.g. "product_name", "in_stock", "review_count").
- Only include fields the user actually asked for. Do not invent extras.
- "required" lists the fields that must always be present (usually the core ones).

User request: "${description}"`;

  const response = await ollama.chat({
    model: modelName,
    format: META_SCHEMA as unknown as Record<string, unknown>,
    options: { temperature: 0 },
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.message.content.trim();
  let gen: GeneratedSchema;
  try {
    gen = JSON.parse(raw) as GeneratedSchema;
  } catch {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    gen = JSON.parse(cleaned) as GeneratedSchema;
  }

  const built = buildSchema(gen, description);
  if (Object.keys(built.input_schema.properties as object).length === 0) {
    throw new Error(
      `Could not derive any fields from "${description}". Try naming fields explicitly, e.g. "title, author, published date".`
    );
  }
  return built;
}

/** Validate + normalize the raw LLM output into a safe OllamaSchema. */
function buildSchema(gen: GeneratedSchema, description: string): OllamaSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const seen = new Set<string>();

  const rawProps = gen?.properties ?? {};
  for (const [rawKey, rawVal] of Object.entries(rawProps)) {
    const key = SNAKE.test(rawKey) ? rawKey : toSnake(rawKey);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const type = ["string", "number", "boolean", "array"].includes(rawVal?.type)
      ? rawVal.type
      : "string";

    if (type === "array") {
      const itemType = ["string", "number", "boolean"].includes(rawVal?.items?.type ?? "")
        ? rawVal.items!.type
        : "string";
      properties[key] = { type: "array", items: { type: itemType } };
    } else {
      properties[key] = { type };
    }
  }

  for (const r of gen?.required ?? []) {
    const key = SNAKE.test(r) ? r : toSnake(r);
    if (seen.has(key)) required.push(key);
  }

  return {
    name: "extract_custom",
    description: `Custom extraction from user request: ${description}`,
    input_schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}
