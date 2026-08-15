import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP } from "../../vitest.shared";

// Live suites for the sign-in surface (#84): the Google provider's redirect and callback against a real
// Google, and the Turnstile gate against a real siteverify. They boot the real auth Worker on a real
// port through `src/test-utils/liveApp.ts` — Miniflare supplies D1 from Node, `node:http` supplies the
// port, and the only thing over the network is the third party each suite names.
//
// They create no Cloudflare resource — no Worker, no database, no widget — so `globalSetup` is the
// report-only one: it says which fixtures this run has and skips the account-wide debris sweep, which
// would be somebody else's housekeeping done on the way past. A live test in this package that ever
// mints a Cloudflare resource must switch that line to `integrationSetup.ts`.
//
// Excluded from the default suite; run via `bun run test:integration`.
export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // A throwaway `PITHY_CONFIG_DIR`, exactly as the unit run has. A live suite needs the real
    // credentials; it has never needed the operator's real config directory (#200).
    setupFiles: [CONFIG_DIR_SETUP],
    globalSetup: ["../cloudflare/src/test-utils/fixtureReportSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    pool: "forks",
    passWithNoTests: true,
  },
});
