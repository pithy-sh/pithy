import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP } from "../../vitest.shared";

// Integration tests run against the LIVE Cloudflare Email Service using credentials from
// `.dev.vars` (the account with the `pithy.sh` apex sending domain onboarded). They send real email
// to `jim+<x>@pithy.sh`, so they are excluded from the default suite (`vitest.config.ts`) and run via
// `bun run test:integration`. They skip cleanly when the live credentials are absent.
//
// `*.integration.test.ts` files load `.dev.vars` themselves and hit the Email Sending REST API
// (the binding can only run inside a Worker), so they run in the node pool — no Miniflare.
//
// The debris sweep is here now, and the note that used to stand in its place said exactly why it would
// have to be: `inboundRouting.integration.test.ts` mints Worker scripts, a KV namespace, and — the one
// kind whose debris changes what happens to somebody's mail — Email Routing rules. `globalSetup` also
// prints the fixture estate, so a run that skips every live suite says which fixture it wanted.
export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["../cloudflare/src/test-utils/integrationSetup.ts"],
    // A throwaway `PITHY_CONFIG_DIR`, exactly as the unit run has. A live suite needs the real
    // account; it has never needed the operator's real config directory (#200).
    setupFiles: [CONFIG_DIR_SETUP],
    testTimeout: 120_000,
    pool: "forks",
    passWithNoTests: true,
  },
});
