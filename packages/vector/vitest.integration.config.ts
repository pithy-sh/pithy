import { defineConfig } from "vitest/config";

// Integration tests run against a LIVE Cloudflare account using credentials from `.dev.vars` (a CF API token
// + account id). They cover what no mock and no local runtime can: Cloudflare ships no emulation for Vectorize
// or Workers AI, so the metadata-index rule this whole package is built around is only observable here.
// Excluded from the default suite; run via `bun run test:integration`. **Required before a release.**
//
// The timeout is minutes, not seconds, on purpose. Vectorize is asynchronous end to end: a metadata index took
// 25–50s to become visible on a live account, and an upsert 30s to be queryable. A tight timeout here would
// not make the suite faster — it would make it flaky, which is worse than not having it.
export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // One debris sweep per run, across every kind — see `@pithy-sh/cloudflare`'s `src/test-utils/reap.ts`.
    // This package mints Vectorize indexes and previously reaped none of them: the only index reaper
    // lived in `@pithy-sh/cloudflare`, so `--filter @pithy-sh/vector` created and never reclaimed.
    globalSetup: ["../cloudflare/src/test-utils/integrationSetup.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: "forks",
    passWithNoTests: true,
  },
});
