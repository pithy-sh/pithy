import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT } from "../../vitest.shared";

// Node-only. This tool reads the repo from disk and never touches a Worker runtime,
// so there is no `workers` project here — `test:node` and `test` are the same run.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
    // No ambient account, no real config directory. #198, #200 — see `vitest.shared.ts`. This tool
    // resolves neither today, and states them anyway: the rule is about every config, not about the
    // ones whose current contents happen to need it.
    env: { ...NO_ACCOUNT },
    setupFiles: [CONFIG_DIR_SETUP],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
