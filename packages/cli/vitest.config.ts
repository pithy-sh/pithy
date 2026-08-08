import { defineConfig } from "vitest/config";

// Node-only tests: the CLI runs outside the Worker. The migrate tests spawn
// real D1 through Miniflare, so they get a longer timeout than pure logic needs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Every test gets a throwaway Pithy config directory — see `vitest.setup.ts`. Dev secrets live
    // there now (#156), and without this a suite scaffolding `--name replay` writes to the real one.
    setupFiles: ["./vitest.setup.ts"],
    // `*.integration.test.ts` need a LIVE Cloudflare environment; run via `bun run test:integration`.
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
    testTimeout: 30_000,
    // Color off, always. `terminal/style.ts` latches `enabled` at import from NO_COLOR/FORCE_COLOR/isTTY,
    // so every test asserting exact output — `formatDone()` is `"Done."`, a deploy failure line, the real
    // bin spawned through `execFile` — passes or fails on the *developer's shell*, not on the code. A
    // terminal that exports `FORCE_COLOR` (wezterm, most agent harnesses, some CI runners) turned seven
    // green tests red with ANSI in the received string. NO_COLOR is checked first in `colorEnabled()`, so
    // it wins over any ambient FORCE_COLOR, and `execFile` children inherit it. `style.test.ts` is
    // unaffected: it stubs all three vars per case and re-imports, which is how color itself stays tested.
    env: { NO_COLOR: "1" },
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
