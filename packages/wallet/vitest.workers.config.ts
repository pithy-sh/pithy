import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 database — never mocks. Correctness is
 * the whole product here: atomicity (a debit and its ledger entry commit together via `DB.batch`),
 * idempotency (a replayed `ref` is a no-op), and overdraft protection (a `CHECK` constraint aborts the
 * transaction) all run against live D1 and are asserted on real rows.
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
