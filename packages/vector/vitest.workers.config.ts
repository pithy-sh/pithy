import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real `DB` D1 database — never mocks. What runs here is
 * the document corpus: the migration's `up`/`down` are exact inverses against live SQLite, and the vector-id
 * length CHECK is proved by SQLite itself rejecting a 65-byte id, because that ceiling is Vectorize's and a
 * row we cannot address in the index is a row we can never re-embed.
 *
 * Vectorize and Workers AI are deliberately absent: Cloudflare ships no local emulation for either, which is
 * why every index and embedding call in this package goes through an injectable seam and is unit-tested with
 * a fake in the node project.
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
