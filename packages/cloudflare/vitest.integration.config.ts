import { defineConfig } from "vitest/config";

// Integration tests run against a LIVE Cloudflare environment using credentials from `.dev.vars`
// (a CF API token + account id). They cover control-plane paths that cannot be mocked — creating
// and deleting real resources. Excluded from the default suite; run via `bun run test:integration`.
// **Required before a release.**
export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 120_000,
    // `testTimeout` does not cover hooks, and these suites reap stale resources in `beforeAll` — a
    // reclaim that has to drain several buckets would blow vitest's 10s hook default and fail the run
    // before a single test executed. Generous, because the staleness window is twelve hours: a busy day
    // of aborted runs can leave a lot to reclaim at once, and a reaper that times out leaves it forever.
    hookTimeout: 300_000,
    pool: "forks",
    passWithNoTests: true,
  },
});
