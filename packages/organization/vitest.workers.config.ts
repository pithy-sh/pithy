import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 database — never mocks.
 *
 * This capability's whole subject is *may this person act here*, and every answer is a query: the
 * acting resolution matches user and organization in one predicate, provisioning writes two rows in one
 * `d1.batch` or neither, an invitation is redeemed by a conditional update so exactly one of N
 * concurrent redemptions wins. A mocked database would assert the code rather than the constraint, and
 * the constraint is the security property.
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
