import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS, WORKERS_ENV_SETUP } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with real bindings: the app `DB` (the `pithy_matchmaking_*`
 * tables), a `MATCHMAKING` KV namespace (room codes), and the two Durable Objects — `QUEUE`
 * (MatchmakingQueue, the pairing coordinator) and `PRESENCE` (MatchmakingPresence, notifications). Room
 * codes, the friend graph, invites, the queue's alarm-driven widening, and the presence socket all run
 * against these, never mocked. `testWorker.ts` registers the DO classes.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/testWorker.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        kvNamespaces: ["MATCHMAKING"],
        durableObjects: { QUEUE: "MatchmakingQueue", PRESENCE: "MatchmakingPresence" },
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
