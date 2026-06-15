import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workers-runtime project: tests run inside workerd via Miniflare with a real D1
// `SECRETS` binding — the dedicated secrets database, separate from any app `DB`.
// Only `*.workers.test.ts` run here. Test bindings are typed in `src/cloudflare-test.d.ts`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["SECRETS"],
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
  },
});
