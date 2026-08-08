import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT } from "../../vitest.shared";

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
          // `*.integration.test.ts` need a LIVE Cloudflare environment; run via `bun run test:integration`.
          exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
          // No ambient account, no real config directory. #198, #200 — see `vitest.shared.ts`.
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP],
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
