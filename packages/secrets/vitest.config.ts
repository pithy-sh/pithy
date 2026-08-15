import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

// One `vitest run`, two projects (mirrors core).
//   node    — pure logic in `*.test.ts`, default node environment.
//   workers — real D1 (`SECRETS`) via Miniflare in `*.workers.test.ts`
//             (see `vitest.workers.config.ts`).
export default defineConfig({
  test: {
    ...UNIT_BUDGETS,
    passWithNoTests: true,
    projects: [
      {
        test: {
          ...UNIT_BUDGETS,
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          // `*.workers.test.ts` run in the workers pool; `*.integration.test.ts` need a LIVE
          // Cloudflare environment and run only via `bun run test:integration`.
          exclude: ["src/**/*.workers.test.ts", "src/**/*.integration.test.ts", "node_modules/**"],
          // No ambient account, no real config directory. #198, #200 — see `vitest.shared.ts`.
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP],
        },
      },
      "./vitest.workers.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.workers.test.ts", "src/**/*.integration.test.ts"],
    },
  },
});
