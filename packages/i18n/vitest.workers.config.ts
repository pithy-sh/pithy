import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

/**
 * Workers-runtime tests run the locale middleware inside Miniflare against real `Request` objects, so
 * the `Accept-Language` header, the cookie jar and the query string behave as they do in production.
 *
 * It is also where the isolate-reuse property is checked. A Worker isolate serves requests from
 * different readers, so a translator held anywhere but on the request applies one reader's language to
 * the next — the same hazard `z.config()` is banned repo-wide for. Two requests through one app is the
 * only place that can be observed.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
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
