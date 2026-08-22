import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

// Workers-runtime project: tests run inside workerd via Miniflare with a real D1 `DB` binding — the
// default audit database binding. Only `*.workers.test.ts` run here. Test bindings are typed in
// `src/cloudflare-test.d.ts`.
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
