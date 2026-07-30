import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 database — never mocks. The claim the
 * whole capability rests on can only be proved against live D1: one provider transaction is one row
 * forever (`UNIQUE (rail, providerTransactionId)`), an event staler than the row it would update changes
 * nothing (the monotonic guard is a SQL predicate, not a JS comparison), and the entitlement read model
 * is re-derived inside the same `DB.batch` as the purchase write, so the two can never disagree. A mock
 * would assert the code we wrote; D1 asserts the constraints.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
      },
    }),
  ],
  test: { name: "workers", include: ["src/**/*.workers.test.ts"] },
});
