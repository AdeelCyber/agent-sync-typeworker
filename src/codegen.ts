import { createRequire } from "node:module";
import { FetchingJSONSchemaStore, InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { NormalizeError } from "./normalize.js";

const require = createRequire(import.meta.url);
const { JSONSchemaFaker } = require("json-schema-faker") as {
  JSONSchemaFaker: { option: (o: object) => void; generate: (schema: object) => unknown };
};

type Schema = Record<string, unknown>;
export type Definitions = Record<string, Schema>;

export const TARGETS = {
  typescript: { lang: "typescript", options: { "just-types": "true" } },
  zod: { lang: "typescript-zod", options: {} },
  pydantic: { lang: "python", options: { "just-types": "true", "pydantic-base-model": "true", "python-version": "3.7" } },
} as const;
export type Target = keyof typeof TARGETS;

/**
 * Prepare contract definitions for quicktype: name each type after its definition (otherwise
 * array items become "ItemElement") and close objects (otherwise every type gets an index signature).
 */
function prepare(node: unknown, name?: string): unknown {
  if (Array.isArray(node)) return node.map((n) => prepare(n));
  if (node && typeof node === "object") {
    const out: Schema = {};
    for (const [k, v] of Object.entries(node as Schema)) out[k] = prepare(v);
    if (out.type === "object" && out.properties && out.additionalProperties === undefined) {
      out.additionalProperties = false;
    }
    if (name) out.title = name;
    return out;
  }
  return node;
}

const ROOT = "AgentSyncRoot";

/** quicktype needs one top-level type; we wrap all definitions in ROOT, then remove ROOT from the output. */
function stripRoot(code: string, target: Target): string {
  const patterns: Record<Target, RegExp> = {
    typescript: /export interface AgentSyncRoot \{[\s\S]*?\n\}\n+/,
    zod: /export const AgentSyncRootSchema = z\.object\(\{[\s\S]*?\n\}\);\nexport type AgentSyncRoot = [^\n]*\n?/,
    pydantic: /\n*class AgentSyncRoot\(BaseModel\):\n(?:[ \t]+[^\n]*\n?)+/,
  };
  return code.replace(patterns[target], "").trimEnd() + "\n";
}

export async function generateTypes(definitions: Definitions, target: Target): Promise<string> {
  const names = Object.keys(definitions);
  if (!names.length) throw new NormalizeError("The contract has no type definitions.", "no_definitions");
  const prepared = Object.fromEntries(names.map((n) => [n, prepare(definitions[n], n)]));
  // One source so shared types keep their contract names (separate sources yield "ItemElement" etc.).
  const root = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(names.map((n) => [n, { $ref: `#/definitions/${n}` }])),
    required: names,
    definitions: prepared,
  };
  const input = new JSONSchemaInput(new FetchingJSONSchemaStore());
  await input.addSource({ name: ROOT, schema: JSON.stringify(root) });
  const inputData = new InputData();
  inputData.addInput(input);
  const { lang, options } = TARGETS[target];
  try {
    const result = await quicktype({ inputData, lang, rendererOptions: options as Record<string, string> });
    return stripRoot(result.lines.join("\n"), target);
  } catch (err) {
    throw new NormalizeError(`Could not generate ${target}: ${(err as Error).message}`, "codegen_failed");
  }
}

/** A seeded PRNG so the same seed gives the same mock (stable demos and tests). */
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Schema-valid fake data for `schema`, resolving refs against the contract's definitions. */
export function mockData(schema: Schema, definitions: Definitions, seed?: number): unknown {
  JSONSchemaFaker.option({
    alwaysFakeOptionals: true,
    fillProperties: false,
    useExamplesValue: true,
    maxItems: 3,
    maxLength: 24,
    failOnInvalidTypes: false,
    random: seed === undefined ? Math.random : seeded(seed),
  });
  try {
    return JSONSchemaFaker.generate({ ...schema, definitions });
  } catch (err) {
    throw new NormalizeError(`Could not generate mock data: ${(err as Error).message}`, "mock_failed");
  }
}
