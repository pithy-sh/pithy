import { defineConfig } from "vitest/config";

// Integration tests run against the LIVE Cloudflare Email Service using credentials from
// `.dev.vars` (the account with the `pithy.sh` apex sending domain onboarded). They send real email
// to `jim+<x>@pithy.sh`, so they are excluded from the default suite (`vitest.config.ts`) and run via
// `bun run test:integration`. They skip cleanly when the live credentials are absent.
//
// `*.integration.test.ts` files load `.dev.vars` themselves and hit the Email Sending REST API
// (the binding can only run inside a Worker), so they run in the node pool — no Miniflare.
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
