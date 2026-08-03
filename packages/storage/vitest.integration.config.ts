import { defineConfig } from "vitest/config";

// Integration tests run against a LIVE Cloudflare environment using credentials from `.dev.vars`
// (a CF API token + account id, plus the R2 S3 key pair). They cover the half of storage Miniflare
// cannot reach: R2 speaks S3 over HTTP, and the emulator serves no S3 endpoint, so a presigned URL —
// the path the design uses precisely to keep bytes out of the Worker — has nothing to address there.
// Excluded from the default suite; run via `bun run test:integration`. **Required before a release.**
export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 120_000,
    // Hooks are not covered by `testTimeout`, and these suites reap stale resources in `beforeAll` —
    // draining several orphaned buckets would blow vitest's 10s hook default and fail the run before a
    // single test executed. Generous, because the staleness window is twelve hours: a busy day of
    // aborted runs can leave a lot to reclaim at once, and a reaper that times out leaves it forever.
    hookTimeout: 300_000,
    pool: "forks",
    passWithNoTests: true,
  },
});
