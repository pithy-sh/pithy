import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

// Node-only. This tool reads the repo from disk and posts one HTTP request; it never touches a Worker
// runtime, so there is no `workers` project here — `test:node` and `test` are the same run.
export default defineConfig({
  test: {
    ...UNIT_BUDGETS,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
    // No ambient account, no real config directory. #198, #200 — see `vitest.shared.ts`.
    env: { ...NO_ACCOUNT },
    setupFiles: [CONFIG_DIR_SETUP],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
