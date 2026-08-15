import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

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
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
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
