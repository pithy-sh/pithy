import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 database — never mocks.
 *
 * Who may see a repository is a query: an ownership row, a grant row, and the unique index that lets two owners
 * both hold `docs`. A mocked database would assert the code rather than the constraint, and the constraint is the
 * security property. The Artifacts binding itself is a stand-in, because Miniflare has no Artifacts simulation.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
      },
    }),
  ],
  test: {
    ...UNIT_BUDGETS,
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
    setupFiles: [WORKERS_ENV_SETUP],
  },
});
