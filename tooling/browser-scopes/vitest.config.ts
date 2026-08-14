import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT } from "../../vitest.shared";

// Node-only. This gate reads the repo from disk and compiles a fixture; nothing here touches a
// Worker runtime, so there is no `workers` project and `test:node` is the same run as `test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
    // No ambient account, no real config directory. #198, #200 — see `vitest.shared.ts`.
    env: { ...NO_ACCOUNT },
    setupFiles: [CONFIG_DIR_SETUP],
  },
});
