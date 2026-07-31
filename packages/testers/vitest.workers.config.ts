import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 database — never mocks. The cohort
 * clock is replayed from an event log with SQL date arithmetic, and the activity reader joins against
 * `@pithy-sh/auth`'s own tables, so a mocked database would assert the code rather than the constraint.
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
