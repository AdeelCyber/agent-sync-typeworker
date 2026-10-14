import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// CommonJS package; quicktype resolves source paths relative to the process cwd ("rootDir").
const { schemaForTypeScriptSources } = require("quicktype-typescript-input") as {
  schemaForTypeScriptSources: (files: string[]) => { schema: string };
};

export const MAX_SOURCE = 200_000;

export class NormalizeError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

type Schema = Record<string, unknown>;

/** quicktype adds `title` to every property and odd names for utility types; strip the noise. */
function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node && typeof node === "object") {
    const out: Schema = {};
    for (const [key, value] of Object.entries(node as Schema)) {
      if (key === "title" || key === "$schema") continue;
      out[key] = clean(value);
    }
    return out;
  }
  return node;
}

/** TypeScript interfaces/types -> {definitions: {Name: JSON Schema}}. Never executes the source. */
export function typescriptToSchema(source: string): { definitions: Record<string, unknown> } {
  if (source.length > MAX_SOURCE) throw new NormalizeError("Source is too large.", "source_too_large");
  const dir = mkdtempSync(join(process.cwd(), ".work-"));
  try {
    const file = relative(process.cwd(), join(dir, "contract.ts"));
    writeFileSync(file, source);
    let raw: string;
    try {
      raw = schemaForTypeScriptSources([file]).schema;
    } catch (err) {
      const message = (err as { userMessage?: string; message?: string }).userMessage ?? String(err);
      throw new NormalizeError(message.replace(/File '[^']*contract\.ts'/g, "the snippet"), "typescript_error");
    }
    const parsed = JSON.parse(raw) as { definitions?: Record<string, unknown> };
    const definitions: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(parsed.definitions ?? {})) {
      // Utility types like Record<string, number> become inline maps.
      if (/[<>]/.test(name)) continue;
      definitions[name] = clean(schema);
    }
    // Rewrite refs to dropped utility types as generic objects.
    const text = JSON.stringify(definitions).replace(/\{"\$ref":"#\/definitions\/[^"]*%3C[^"]*"\}/g, '{"type":"object"}');
    return { definitions: JSON.parse(text) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
