import { defineConfig } from "vitest/config";

/**
 * Every integration test file boots its own embedded PGlite (WASM Postgres)
 * and applies the full migration set, which is memory-heavy per worker. Left
 * unbounded, vitest scales workers to the CPU count and the suite fails at
 * the file level — worker termination rather than assertion failure — as soon
 * as anything else is running on the machine. Capping workers trades ~30s of
 * wall clock for a gate that means what it says.
 */
export default defineConfig({
  test: {
    maxWorkers: 3,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
