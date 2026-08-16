import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { COMPATIBILITY_DATE } from "../../compatibility";
import { UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Workers-runtime tests run against Miniflare with a real D1 `DB` binding — the same database the
 * `pithy_leaderboard_*` tables live in. Ranking is the whole product here, so it is never mocked: the
 * rank predicate, the chunked materialize pass, and the retention sweep all run against live D1 and are
 * asserted on real rows. The query-plan test (`rank/plan.workers.test.ts`) reads D1's own `EXPLAIN QUERY
 * PLAN` output to prove the ranking index is used rather than trusting that it is.
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
  },
});
