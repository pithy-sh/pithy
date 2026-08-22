import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with real D1 and KV bindings — the same `DB` database the
 * `pithy_media_*` tables live in and the `MEDIA` KV namespace the `recordStore: 'kv'` path writes to.
 * The Cloudflare REST calls (direct-upload minting, Workers AI) are exercised against injected fakes so
 * the storage and enrichment paths are deterministic without a real account, while D1/KV reads and
 * writes hit the live Miniflare bindings.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        kvNamespaces: ["MEDIA"],
      },
    }),
  ],
  test: {
    ...UNIT_BUDGETS,
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
  },
});
