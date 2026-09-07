import { defineConfig } from "vitest/config";

/**
 * Every integration test file boots its own embedded PGlite (WASM Postgres)
 * and applies the full migration set, which is memory-heavy per worker. Left
 * unbounded, vitest scales workers to the CPU count and the suite fails at
 * the file level — worker termination rather than assertion failure — as soon
 * as anything else is running on the machine. Capping workers trades ~30s of
 * wall clock for a gate that means what it says.
 *
 * `hookTimeout` is 300s rather than the 30s default because that bootstrap —
 * migrate 216 tables into a fresh WASM Postgres — runs in `beforeAll`, and on
 * a loaded machine it routinely takes minutes. At 30s the suite reported
 * timeouts in `beforeAll` for whichever files happened to start together,
 * which reads as a broken package and is nothing of the kind. Three separate
 * work packages hit this independently and each raised the timeout inside
 * their own test files; it belongs here, once, so every package benefits and
 * nobody has to rediscover it.
 *
 * A timeout here is therefore worth believing: it means the bootstrap really
 * did not finish, not that the runner was busy. If the suite still reports
 * hook timeouts, re-run it with `--maxWorkers=1` before concluding anything —
 * a starved runner is not a failing test.
 */
export default defineConfig({
  test: {
    maxWorkers: 3,
    minWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
