import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.workers.test.ts", "src/**/*.integration.test.ts", "node_modules/**"],
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
