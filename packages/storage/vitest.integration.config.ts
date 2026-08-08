import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP } from "../../vitest.shared";

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
    // A throwaway `PITHY_CONFIG_DIR`, exactly as the unit run has. A live suite needs the real
    // account; it has never needed the operator's real config directory (#200).
    setupFiles: [CONFIG_DIR_SETUP],
    // One debris sweep per run, across every kind — see `@pithy-sh/cloudflare`'s `src/test-utils/reap.ts`
    // for why this cannot live in a suite's `beforeAll`.
    globalSetup: ["../cloudflare/src/test-utils/integrationSetup.ts"],
    testTimeout: 120_000,
    // Hooks are not covered by `testTimeout`. Generous, because the staleness window is twelve hours: a
    // busy day of aborted runs can leave a lot to reclaim at once, and a reaper that times out leaves it
    // forever.
    hookTimeout: 300_000,
    pool: "forks",
    passWithNoTests: true,
  },
});
