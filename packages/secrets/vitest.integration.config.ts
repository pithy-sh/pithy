import { defineConfig } from "vitest/config";

// Integration tests run against a LIVE Cloudflare environment using credentials from `.dev.vars`
// (a CF API token, account id, a real Secrets Store, a deployed manager Workflow). They cover the
// paths that cannot run locally — writing entries to CF Secrets Store, real Workflow dispatch +
// poll, real provisioning. Excluded from the default suite (`vitest.config.ts`); run via
// `bun run test:integration`. **These are required to pass before a release.**
//
// `*.integration.test.ts` files load `.dev.vars` themselves and hit the Cloudflare REST APIs, so
// they run in the node pool (no Miniflare).
export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // One debris sweep per run, across every kind — see `@pithy-sh/cloudflare`'s `src/test-utils/reap.ts`
    // for why this cannot live in a suite's `beforeAll`. This package writes real Secrets Store entries,
    // the kind that had no reaper at all.
    globalSetup: ["../cloudflare/src/test-utils/integrationSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    pool: "forks",
    passWithNoTests: true,
  },
});
