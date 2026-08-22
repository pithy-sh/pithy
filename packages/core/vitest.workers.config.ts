import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

// Workers-runtime project: tests run inside workerd via Miniflare, with real
// D1 (`DB`, plus `ANALYTICS` to exercise multiple databases) and KV (`SESSIONS`,
// plus `CONTROL_PLANE` for the control-plane seam's replay set) bindings — not
// mocks. Only `*.workers.test.ts` run here. The bindings are typed for tests in
// `src/cloudflare-test.d.ts`.
//
// `cloudflareTest` is a Vite plugin, not a pool. One release did that: 0.13.0.
// It replaced the old `defineWorkersConfig`/`poolOptions.workers` shape with
// this plugin — the former pool options are now the plugin's argument — and it
// removed `fetchMock` in the same move. 0.12.21 still exports
// `defineWorkersConfig` and still ships `fetchMock`; 0.13.0 exports neither.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB", "ANALYTICS"],
        kvNamespaces: ["SESSIONS", "CONTROL_PLANE"],
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
