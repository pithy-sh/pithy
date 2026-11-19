import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

// Node-only. The gate runs commands and the composition is checked as data; the Worker itself is measured by
// `wrangler check startup`, never under test, so there is no `workers` project here.
export default defineConfig({
  test: {
    ...UNIT_BUDGETS,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
    // No ambient account, no real config directory — see `vitest.shared.ts`.
    env: { ...NO_ACCOUNT },
    setupFiles: [CONFIG_DIR_SETUP],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
