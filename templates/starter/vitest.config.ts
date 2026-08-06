import { defineConfig } from "vitest/config";

// Two projects, split by runtime, because a Pithy project has two runtimes.
//
// `node` runs plain unit tests in Node — codecs, pure logic, anything with no binding in it.
// `workers` runs against the real Workers runtime with real D1 and KV, in vitest.workers.config.ts.
// A test that touches a binding belongs there and nowhere else: mocking D1 proves your mock works.
//
// The split is by filename, not by directory: `*.workers.test.ts` is the Workers project, every other
// `*.test.ts` is the node one. Tests sit beside the code they cover, so a folder rule would mean
// choosing between co-location and the runtime — and the runtime is not negotiable.
export default defineConfig({
  test: {
    // A scaffolded project starts with almost no tests. `bun run test` should still be green.
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["apps/*/src/**/*.test.ts"],
          exclude: ["apps/*/src/**/*.workers.test.ts"],
        },
      },
      "./vitest.workers.config.ts",
    ],
  },
});
