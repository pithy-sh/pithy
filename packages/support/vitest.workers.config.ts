import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real D1 `DB` binding — the same database the
 * `pithy_support_*` tables live in — and a real `SUPPORT_BUCKET` R2 bucket for attachment bytes.
 *
 * Ingest, the FTS5 search index, cursor pagination, and every migration rollback are asserted on live
 * rows rather than mocks: FTS5 is a SQLite feature, and a fake would prove nothing about whether D1
 * actually accepts the virtual table and its triggers. Workers AI and the outbound send path are
 * exercised against injected fakes, so classification and reply stay deterministic without an account.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["SUPPORT_BUCKET"],
      },
    }),
  ],
  test: {
    ...UNIT_BUDGETS,
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
  },
});
