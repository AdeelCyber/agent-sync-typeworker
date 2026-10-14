import { defineConfig } from "vitest/config";

// TypeScript compilation inside tests is slow on busy machines.
export default defineConfig({ test: { testTimeout: 60_000 } });
