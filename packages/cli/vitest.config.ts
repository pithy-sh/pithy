import { defineConfig } from "vitest/config";

// Node-only tests: the CLI runs outside the Worker. The migrate tests spawn
// real D1 through Miniflare, so they get a longer timeout than pure logic needs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `*.integration.test.ts` need a LIVE Cloudflare environment; run via `bun run test:integration`.
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
    testTimeout: 30_000,
    // picocolors detects color support once, at import. Inline it so
    // `vi.resetModules()` re-evaluates that detection under a stubbed env.
    server: { deps: { inline: ["picocolors"] } },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
