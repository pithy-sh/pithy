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
    pool: "forks",
    passWithNoTests: true,
  },
});
