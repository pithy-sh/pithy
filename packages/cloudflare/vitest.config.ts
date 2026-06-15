import { defineConfig } from "vitest/config";

// `@pithy-sh/cloudflare` is an out-of-Worker REST client — it runs in Node/Bun (CLI, CI,
// provisioning), never inside a Worker. So there is no Miniflare project here: every test runs
// in the node environment with the `cloudflare` SDK mocked (`vi.mock("cloudflare")`).
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["node_modules/**"],
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
