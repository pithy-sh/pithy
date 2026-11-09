import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT, UNIT_BUDGETS } from "../../vitest.shared";
import { nativeTestProject } from "./src/testing/vitest";

/**
 * `node` checks the library: the manifest, the version and the generated config's shape.
 *
 * `native` renders the templates, and it is the project `nativeTestProject` gives an app, so the kit tests the
 * preset apps get. `native-bare-home` is the same preset, for the one seeded test whose import names a path the
 * tree holds under another name. The templates are typechecked against React Native's own types separately, by
 * `tsconfig.templates.json`. A test reaches a stand-in's controls by its relative path under `testing/` or by its
 * package path, and both are the module the alias loads. The app's own payments-store files are the templates'.
 */
const native = nativeTestProject({
  include: ["src/**/*.test.tsx", "templates/**/*.test.tsx"],
  src: "templates/src",
});

/**
 * The bare home screen's test, which imports `./home` because that is where the scaffold writes the screen. In the
 * tree the bare screen is `home.bare.tsx` beside the auth one, so this project points `./home` at it.
 */
const BARE_HOME_TEST = "templates/src/routes/app/home.bare.test.tsx";
const bareHome = nativeTestProject({ include: [BARE_HOME_TEST], src: "templates/src", name: "native-bare-home" });

/**
 * The deep-link test, which runs the real `expo-router` on the web instead of its stand-in. Vitest's dependency
 * optimizer bundles `expo-router` for the browser as Metro's web build does: `react-native` as `react-native-web`,
 * `.web` files first, `EXPO_OS` set to `web`, and assets inlined. React and the testing library are bundled with it so
 * the router and the test render through one React. Metro's `require.context` setup is left out, because the bundle
 * reaches `require` by the global name that setup replaces.
 */
const WEB_ROUTER_TEST = "src/webDeepLink.test.tsx";
const WEB_EXTENSIONS = [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json"];
const WEB_DEFINE = { __DEV__: "true", "process.env.EXPO_OS": JSON.stringify("web") };
const webRouterBase = nativeTestProject({ include: [WEB_ROUTER_TEST], src: "templates/src", name: "web-router" });
const webRouter: typeof native = {
  ...webRouterBase,
  define: WEB_DEFINE,
  resolve: {
    extensions: WEB_EXTENSIONS,
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      ...((webRouterBase.resolve?.alias ?? []) as { find: RegExp; replacement: string }[]).filter(
        (rule) => !rule.find.test("expo-router") && !rule.find.test("expo-linking"),
      ),
    ],
  },
  optimizeDeps: {
    rolldownOptions: {
      resolve: { extensions: WEB_EXTENSIONS },
      moduleTypes: { ".js": "jsx", ".png": "dataurl", ".ttf": "dataurl" },
      transform: { define: WEB_DEFINE },
      // `expo-modules-core` imports types by value from its TypeScript sources.
      shimMissingExports: true,
    },
  },
  test: {
    ...webRouterBase.test,
    setupFiles: [webRouterBase.test?.setupFiles ?? []].flat().filter((file) => !file.endsWith("metro.ts")),
    deps: {
      optimizer: {
        client: {
          enabled: true,
          include: [
            "react",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "react-dom",
            "react-dom/client",
            "react-native-web",
            "@testing-library/react",
            "expo-router",
          ],
        },
      },
    },
  },
};

/** A preset project with the kit's own budgets, config directory and unset account. */
function kitNative(project: typeof native, exclude: string[] = []): typeof native {
  return {
    ...project,
    test: {
      ...project.test,
      ...UNIT_BUDGETS,
      exclude: ["node_modules/**", ...exclude],
      env: { ...NO_ACCOUNT },
      setupFiles: [CONFIG_DIR_SETUP, ...(project.test?.setupFiles ?? [])],
    },
  };
}

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
      kitNative(native, [BARE_HOME_TEST, WEB_ROUTER_TEST]),
      kitNative(webRouter),
      {
        ...kitNative(bareHome),
        resolve: {
          alias: [
            {
              find: /^\.\/home$/,
              replacement: fileURLToPath(new URL("./templates/src/routes/app/home.bare.tsx", import.meta.url)),
            },
            ...((bareHome.resolve?.alias ?? []) as { find: RegExp; replacement: string }[]),
          ],
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
