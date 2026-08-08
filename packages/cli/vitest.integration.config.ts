import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP } from "../../vitest.shared";

// Integration tests run against a LIVE Cloudflare environment using credentials from `.dev.vars`
// (a CF API token + account id + Secrets Store id). They cover control-plane paths that cannot be
// mocked — provisioning and tearing down real resources, deploying real Workers. Excluded from the
// default suite; run via `bun run test:integration`. **Required before a release.**
export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // A throwaway `PITHY_CONFIG_DIR`, exactly as the unit run has. A live suite needs the real
    // account; it has never needed the operator's real config directory (#200).
    setupFiles: [CONFIG_DIR_SETUP],
    // One debris sweep per run, across every kind — see `@pithy-sh/cloudflare`'s `src/test-utils/reap.ts`.
    globalSetup: ["../cloudflare/src/test-utils/integrationSetup.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Color off, as in the default suite — these assert CLI output too, and the shell must not decide it.
    env: { NO_COLOR: "1" },
    pool: "forks",
    passWithNoTests: true,
  },
});
