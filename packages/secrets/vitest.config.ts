import { defineConfig } from "vitest/config";

// One `vitest run`, two projects (mirrors core).
//   node    — pure logic in `*.test.ts`, default node environment.
//   workers — real D1 (`SECRETS`) via Miniflare in `*.workers.test.ts`
//             (see `vitest.workers.config.ts`).
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.workers.test.ts", "node_modules/**"],
        },
      },
      "./vitest.workers.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.workers.test.ts"],
    },
  },
});
