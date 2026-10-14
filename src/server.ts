import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { generateTypes, mockData, TARGETS, type Definitions, type Target } from "./codegen.js";
import { NormalizeError, typescriptToSchema, MAX_SOURCE } from "./normalize.js";

const SECRET = process.env.TYPEWORKER_SECRET ?? "dev-typeworker-secret";
const PORT = Number(process.env.PORT ?? 8790);

export function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: MAX_SOURCE * 2 });

  // Internal service: every call must carry the shared secret.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    if (request.headers["x-worker-secret"] !== SECRET) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post<{ Body: { language?: string; source?: string } }>("/normalize", async (request, reply) => {
    const { language, source } = request.body ?? {};
    if (typeof source !== "string" || !source.trim()) {
      return reply.code(400).send({ error: "invalid_request", message: "source is required" });
    }
    if (language !== "typescript") {
      return reply.code(400).send({ error: "unsupported_language", message: `Unsupported language: ${language}` });
    }
    try {
      return typescriptToSchema(source);
    } catch (err) {
      if (err instanceof NormalizeError) return reply.code(422).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post<{ Body: { definitions?: Definitions; target?: string } }>("/codegen", async (request, reply) => {
    const { definitions, target } = request.body ?? {};
    if (!definitions || typeof definitions !== "object") {
      return reply.code(400).send({ error: "invalid_request", message: "definitions are required" });
    }
    if (!target || !(target in TARGETS)) {
      return reply.code(400).send({ error: "unsupported_target", message: `Unsupported target: ${target}` });
    }
    try {
      return { code: await generateTypes(definitions, target as Target) };
    } catch (err) {
      if (err instanceof NormalizeError) return reply.code(422).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post<{ Body: { schema?: Record<string, unknown>; definitions?: Definitions; seed?: number } }>(
    "/mock",
    async (request, reply) => {
      const { schema, definitions, seed } = request.body ?? {};
      if (!schema || typeof schema !== "object") {
        return reply.code(400).send({ error: "invalid_request", message: "schema is required" });
      }
      try {
        return { data: mockData(schema, definitions ?? {}, seed) };
      } catch (err) {
        if (err instanceof NormalizeError) return reply.code(422).send({ error: err.code, message: err.message });
        throw err;
      }
    },
  );

  return app;
}

// Start listening only when run directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildServer()
    .listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
