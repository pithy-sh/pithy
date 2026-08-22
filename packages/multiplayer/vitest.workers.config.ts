import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real `SESSIONS` Durable Object namespace and a real
 * `DB` D1 database — never mocks. Authority is the whole product here, so the session lifecycle,
 * commit-reveal resolution, hidden-state redaction, hibernation-safe WebSocket handling, and the durable
 * D1 result write all run against a live DO and are asserted on real state.
 *
 * `main` points at a tiny worker module that exports the `MultiplayerSession` class so Miniflare can
 * register the namespace — the same re-export an adopter's worker performs. `runInDurableObject` /
 * `runDurableObjectAlarm` from `cloudflare:test` drive the object directly.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/session/testWorker.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        durableObjects: { SESSIONS: "MultiplayerSession" },
      },
    }),
  ],
  test: {
    ...UNIT_BUDGETS,
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
  },
});
