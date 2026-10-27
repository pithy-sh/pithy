import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP } from "../../vitest.shared";

// Integration tests run against a LIVE Cloudflare account using credentials from `.dev.vars` or the environment.
// They cover the half of artifacts Miniflare cannot reach: there is no Artifacts simulation, and the binding exists
// only inside a deployed Worker, so what `listTokens()` returns and whether revoking every token reaches past its
// first page can only be asked of the real one (#849). Excluded from the default suite; run via
// `bun run test:integration`. **Required before a release.**
export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // A throwaway `PITHY_CONFIG_DIR`, exactly as the unit run has.
    setupFiles: [CONFIG_DIR_SETUP],
    // One debris sweep per run, across every kind — see `@pithy-sh/cloudflare`'s `src/test-utils/reap.ts`.
    globalSetup: ["../cloudflare/src/test-utils/integrationSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    pool: "forks",
    passWithNoTests: true,
  },
});
