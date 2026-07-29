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
    // No `server.deps.inline` for picocolors. An earlier comment here claimed the inline was needed
    // so `vi.resetModules()` could re-evaluate picocolors' import-time color detection — but
    // `terminal/style.ts` never consults that detection. It computes its own `enabled` flag from
    // NO_COLOR/FORCE_COLOR/isTTY and passes it explicitly to `pc.createColors(enabled)`, which is a
    // pure function of its argument. What latches at import is style.ts's own module-level const,
    // and `vi.resetModules()` + re-import re-evaluates that whether picocolors is inlined or not.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
