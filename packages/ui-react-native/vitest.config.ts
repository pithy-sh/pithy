import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";

/**
 * Two projects. `node` checks the library: the manifest, the version and the generated config's shape.
 *
 * `native` renders the templates. React Native's own entry is untransformed Flow that only Metro can load, so
 * `react-native` is aliased to `react-native-web`, which implements the same components over the DOM, and the
 * render lands in happy-dom. What that proves is the screen's logic and its use of the theme; the templates are
 * typechecked against React Native's own types separately, by `tsconfig.templates.json`.
 *
 * Every native module a template reaches for is aliased to a stand-in under `testing/`, which keeps the one
 * behavior the kit relies on and lets a test drive the rest: the secure store is a map that outlives a mount, the
 * store's purchase listener is something a test fires. A test imports the stand-in by its relative path to reach
 * those controls; it is the same module the alias loads. `testing/reset.ts` returns each one to a fresh install
 * after every test.
 */
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const NATIVE_STUBS: Readonly<Record<string, string>> = {
  "expo-secure-store": "./testing/expo-secure-store.ts",
  "expo-crypto": "./testing/expo-crypto.ts",
  "expo-router": "./testing/expo-router.ts",
  "expo-web-browser": "./testing/expo-web-browser.ts",
  "expo-linking": "./testing/expo-linking.ts",
  "expo-localization": "./testing/expo-localization.ts",
  "expo-apple-authentication": "./testing/expo-apple-authentication.ts",
  "expo-iap": "./testing/expo-iap.ts",
  "react-native-webview": "./testing/react-native-webview.ts",
  "@react-native-async-storage/async-storage": "./testing/async-storage.ts",
  "@react-native-google-signin/google-signin": "./testing/google-signin.ts",
};

/**
 * Metro's `require.context`, reached through `globalThis` under test. The module runner hands every module its own
 * `require`, which has no `context`, so a test that stubs `globalThis.require` could never reach the call
 * `route-modules.ts` makes. Metro reads the call literally, so the template keeps writing it bare.
 */
const metroRequireContext = {
  name: "metro-require-context",
  transform(code: string): string | undefined {
    return code.includes("require.context(")
      ? code.replaceAll("require.context(", "globalThis.require.context(")
      : undefined;
  },
};

const escapeRegExp = (name: string): string => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

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
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP],
        },
      },
      {
        esbuild: { jsx: "automatic" },
        plugins: [metroRequireContext],
        resolve: {
          alias: [
            { find: /^react-native$/, replacement: here("./node_modules/react-native-web") },
            ...Object.entries(NATIVE_STUBS).map(([name, stub]) => ({
              find: new RegExp(`^${escapeRegExp(name)}$`),
              replacement: here(stub),
            })),
            // Metro picks `payments-store.native.ts` or `payments-store.ts` by platform; the stand-in picks per call.
            { find: /^\.\/payments-store$/, replacement: here("./testing/payments-store.ts") },
          ],
        },
        test: {
          ...UNIT_BUDGETS,
          name: "native",
          environment: "happy-dom",
          include: ["src/**/*.test.tsx", "templates/**/*.test.tsx"],
          exclude: ["node_modules/**"],
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP, here("./testing/metro.ts"), here("./testing/reset.ts")],
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
