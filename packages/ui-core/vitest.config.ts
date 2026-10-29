import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Two projects. `node` runs the pure logic and the package's own invariants. `dom` renders the hooks through
 * react-dom into happy-dom, because a hook is only proven by a component that calls it.
 */
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
          exclude: ["node_modules/**"],
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP],
        },
      },
      {
        esbuild: { jsx: "automatic" },
        test: {
          ...UNIT_BUDGETS,
          name: "dom",
          environment: "happy-dom",
          include: ["src/**/*.test.tsx"],
          exclude: ["node_modules/**"],
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
