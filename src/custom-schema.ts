/**
 * custom-schema.ts
 * Helpers for building Ollama-compatible extraction schemas at runtime.
 * Replaces the @anthropic-ai/sdk Tool type with a local equivalent so
 * the project has no hard dependency on the Anthropic SDK.
 */

// Local Tool type — mirrors the subset we actually use from @anthropic-ai/sdk
interface Tool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface CustomSchemaField {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
  items?: { type: string };
}

/**
 * Build a Tool-compatible schema from a simple field list.
 * Used by the AI extractor when no built-in schema matches.
 */
export function buildDynamicSchema(schemaName: string, fields?: CustomSchemaField[]): Tool {
  if (!fields || fields.length === 0) {
    // Fallback: generic key-value extraction
    return {
      name: `extract_${schemaName}`,
      description: `Extract structured data from a ${schemaName} page.`,
      input_schema: {
        type: "object",
        properties: {
          title:       { type: "string",  description: "Main title or heading" },
          description: { type: "string",  description: "Main description or summary" },
          url:         { type: "string",  description: "Canonical URL if present" },
          metadata:    { type: "object",  description: "Any other structured data found" },
        },
        required: ["title"],
      },
    };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields) {
    const prop: Record<string, unknown> = { type: field.type };
    if (field.description) prop.description = field.description;
    if (field.type === "array" && field.items) prop.items = field.items;
    properties[field.name] = prop;
    if (field.required) required.push(field.name);
  }

  return {
    name: `extract_${schemaName}`,
    description: `Extract ${schemaName} data from the page.`,
    input_schema: { type: "object", properties, required },
  };
}

/**
 * Parse a user-supplied JSON string into a Tool schema.
 * Throws if the JSON is malformed or missing required fields.
 */
export function parseCustomSchema(json: string): Tool {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Custom schema must be valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Custom schema must be a JSON object.");
  }

  const obj = parsed as Record<string, unknown>;

  if (!obj.name || typeof obj.name !== "string") {
    throw new Error("Custom schema must have a string 'name' field.");
  }

  if (!obj.input_schema || typeof obj.input_schema !== "object") {
    throw new Error("Custom schema must have an 'input_schema' object.");
  }

  return parsed as Tool;
}
