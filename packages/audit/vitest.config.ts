import { defineConfig } from "vitest/config";

// One `vitest run`, two projects (mirrors core/secrets).
//   node    — pure logic in `*.test.ts` (the CLI emitter, actor resolution, codecs).
//   workers — real D1 (`DB`) via Miniflare in `*.workers.test.ts` (the recorder, migrations, query).
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
