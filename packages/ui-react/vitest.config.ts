import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Two projects, because the templates are two kinds of artifact.
 *
 * `node` checks the library — the manifest, the route-glob build gate, the text-level invariants a
 * screen has to hold whatever renders it.
 *
 * `dom` renders a screen. The sign-in template is the first thing an adopter sees and it has states —
 * a pending humanity check, a provider that answers with nothing followable — that no assertion about
 * source text can reach. `happy-dom` is a per-project environment here rather than the per-file
 * docblock `@pithy-sh/payments` uses, because every `.tsx` test in this package wants it and none of
 * the `.ts` ones do; the include patterns already draw that line.
 *
 * **The `virtual:pithy/*` aliases are the price of testing the real file.** A screen reads its
 * capability projection through `src/pithy-config.tsx`, which imports modules `@pithy-sh/vite` serves
 * at build time and that nothing outside a Vite build can resolve. The screens take their projection
 * as a prop precisely so a test never depends on those values — but importing the module still
 * evaluates them, so they are pointed at stubs that project `{ enabled: false }`, the same shape an
 * uncomposed capability projects in a real build.
 */
const virtualStub = (name: string): string => fileURLToPath(new URL(`./src/testing/${name}.ts`, import.meta.url));

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
          exclude: ["node_modules/**"],
          // No ambient account, no real config directory. #198, #200 — see `vitest.shared.ts`.
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP],
        },
      },
      {
        // The templates compile as `jsx: react-jsx` (see `tsconfig.templates.json`); vitest reads this
        // package's own tsconfig, which is the node program and declares no JSX, so it is stated here.
        esbuild: { jsx: "automatic" },
        resolve: {
          alias: {
            "virtual:pithy/auth": virtualStub("virtualAuth"),
            "virtual:pithy/payments": virtualStub("virtualPayments"),
            "virtual:pithy/turnstile": virtualStub("virtualTurnstile"),
          },
        },
        test: {
          ...UNIT_BUDGETS,
          name: "dom",
          environment: "happy-dom",
          // `templates/**` joins `src/**` because one test now lives in the template tree and is
          // seeded with it (#383). A gate the kit ships to adopters and never runs itself is the same
          // silence this issue exists to end, one level up — so it runs here, exactly as it will run
          // there: same file, same mock, no alias of ours in the path.
          include: ["src/**/*.test.tsx", "templates/**/*.test.tsx"],
          exclude: ["node_modules/**"],
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
