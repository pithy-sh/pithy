import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

// Node-only. This package's real gate is `tsc`, and the one test beside it reads manifests and
// resolves module paths; nothing here touches a Worker runtime, so `test:node` is the same run as
// `test`.
export default defineConfig({
  test: {
    ...UNIT_BUDGETS,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
    // No ambient account, no real config directory. #198, #200 — see `vitest.shared.ts`.
    env: { ...NO_ACCOUNT },
    setupFiles: [CONFIG_DIR_SETUP],
  },
});
