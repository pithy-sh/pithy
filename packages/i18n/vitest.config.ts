import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Three projects, because this package is three kinds of artifact.
 *
 * `node` checks the decisions — config validation, the two resolver chains, the catalogs, the coverage
 * check. All of it is pure, so none of it needs a runtime.
 *
 * `dom` renders the React bindings and runs the browser half. The provider and `useNegotiatedLocale`
 * are a public API an adopter consumes without ever touching a kit template, and `applyProjectedLocale`
 * is the one line every scaffolded `client.tsx` calls — so they are tested the way a page uses them,
 * against a real `window`, a real `localStorage` and a real `document`.
 *
 * `workers` runs the middleware inside Miniflare, where a request has a real `Accept-Language` header
 * and the isolate really is reused between requests — which is the property the per-request translator
 * exists to hold.
 *
 * **`*.browser.test.ts` is the third suffix, and it earns one for the reason `*.workers.test.ts` does.**
 * A project's environment is per-file here, not per-directory: `src/browser/**` and `src/react/**` want
 * `happy-dom`, everything else wants node, and a plain `.test.ts` beside either is ambiguous. The
 * suffix says which runtime a file is asking for, in the file's own name, the same way the Workers
 * tests already do. `.test.tsx` needs no suffix — a file with JSX in it is a rendering test by
 * construction.
 */
export default defineConfig({
  test: {
    ...UNIT_BUDGETS,
    passWithNoTests: true,
    projects: [
      {
        test: {
          ...UNIT_BUDGETS,
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: [
            "src/**/*.workers.test.ts",
            "src/**/*.browser.test.ts",
            "src/**/*.integration.test.ts",
            "node_modules/**",
          ],
          // No ambient account, no real config directory. #198, #200 — see `vitest.shared.ts`.
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP],
        },
      },
      {
        test: {
          ...UNIT_BUDGETS,
          name: "dom",
          environment: "happy-dom",
          include: ["src/**/*.test.tsx", "src/**/*.browser.test.ts"],
          exclude: ["node_modules/**"],
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP],
        },
      },
      "./vitest.workers.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.workers.test.ts",
        "src/**/*.browser.test.ts",
        "src/**/*.integration.test.ts",
      ],
    },
  },
});
