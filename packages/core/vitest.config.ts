import { defineConfig } from "vitest/config";

// One `vitest run`, two projects. Vitest 4 drives multiple projects through
// `test.projects` — workspace files (`vitest.workspace.ts`) were removed.
//   node    — pure logic in `*.test.ts`, default node environment.
//   workers — real D1 (`DB`) + KV (`SESSIONS`) via Miniflare in `*.workers.test.ts`
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
