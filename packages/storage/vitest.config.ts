import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          // `*.integration.test.ts` need live R2 over the S3 protocol — Miniflare serves no S3
          // endpoint, so the presigned paths can only run against a real bucket. `bun run test:integration`.
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
