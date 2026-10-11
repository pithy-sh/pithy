import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

// The CLI's Windows set (#702): `*.windows.test.ts`, and only that. Each one touches the real platform —
// a real `.cmd`, a real `%APPDATA%`, a filename Windows refuses — so it proves something only on a Windows
// host, and `ci.yml`'s `windows` job is the one place it runs. The default `vitest.config.ts` excludes the
// set, and every file in it calls `requireWindows()`, so it fails rather than passes on any other host.
//
// The same isolation as the default config, for the same reasons: a throwaway config directory per file,
// no Cloudflare credentials, no color. `testIsolation.test.ts` holds this config to both, like every other.
export default defineConfig({
  test: {
    ...UNIT_BUDGETS,
    name: "windows",
    environment: "node",
    include: ["src/**/*.windows.test.ts", "src/**/*.windows.test.tsx"],
    setupFiles: [CONFIG_DIR_SETUP],
    env: { ...NO_ACCOUNT, NO_COLOR: "1" },
  },
});
