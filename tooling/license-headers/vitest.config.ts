import { defineConfig } from "vitest/config";

// Node-only. This tool reads the repo from disk and never touches a Worker runtime,
// so there is no `workers` project here — `test:node` and `test` are the same run.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
