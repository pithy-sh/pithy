import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS } from "../../vitest.shared";

// Workers-runtime project: tests run inside workerd via Miniflare, with real
// D1 (`DB`, plus `ANALYTICS` to exercise multiple databases) and KV (`SESSIONS`,
// plus `CONTROL_PLANE` for the control-plane seam's replay set) bindings — not
// mocks. Only `*.workers.test.ts` run here. The bindings are typed for tests in
// `src/cloudflare-test.d.ts`.
//
// `@cloudflare/vitest-pool-workers` 0.16 replaced the old
// `defineWorkersConfig`/`poolOptions.workers` shape with the `cloudflareTest`
// Vite plugin; the former pool options are now the plugin's argument.
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
  },
});
