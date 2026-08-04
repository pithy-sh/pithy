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
    // One debris sweep per run, across every resource kind, before a single suite is collected. It lives
    // here rather than in a suite's `beforeAll` because Vitest runs no hooks inside a `describe.skipIf`
    // — which gated each reaper on exactly the credential whose absence lets debris accumulate. See
    // `src/test-utils/reap.ts`.
    globalSetup: ["./src/test-utils/integrationSetup.ts"],
    testTimeout: 120_000,
    // `testTimeout` does not cover hooks. Generous, because the staleness window is twelve hours: a busy
    // day of aborted runs can leave a lot to reclaim at once, and a reaper that times out leaves it
    // forever.
    hookTimeout: 300_000,
    pool: "forks",
    passWithNoTests: true,
  },
});
