import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 database and a real
 * `STORAGE_BUCKET` R2 bucket — never mocks. Two things are proved here that a fake cannot prove.
 * Against D1: the migration's `up`/`down` are exact inverses, the `visibility` and `status` CHECK
 * constraints are enforced by SQLite itself, and the quota sum counts `pending` reservations
 * alongside `stored` bytes, so concurrent inits cannot race past the limit. Against R2: the
 * multipart lifecycle — create, upload every planned part, complete, and abort — runs end to end
 * on the part plan `object/multipart.ts` computes, so the plan is validated by R2 accepting it.
 *
 * Miniflare emulates R2 through the **binding**, not the S3 HTTP protocol, so a *presigned* part
 * URL cannot be exercised here. That path lives in `*.integration.test.ts` against a live bucket.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["STORAGE_BUCKET"],
      },
    }),
  ],
  test: {
    ...UNIT_BUDGETS,
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
  },
});
