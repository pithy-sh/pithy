// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProjectInlineConfiguration } from "vitest/config";
import { STAND_INS } from "./standIns";

/**
 * A Vitest project that renders React Native screens in happy-dom, with a stand-in for every native module the
 * templates reach for.
 *
 * React Native's own entry is untransformed Flow that only Metro can load, so `react-native` resolves to
 * `react-native-web`, which implements the same components over the DOM. Each native module is aliased to the
 * stand-in of the same name under this package's `testing/`, which keeps the one behavior the screens rely on and
 * gives a test controls for the rest. Metro's `require.context` is reached through `globalThis`, which
 * `testing/metro.ts` answers with an empty directory, and `testing/reset.ts` returns every stand-in to a fresh
 * install after each test.
 *
 * The stand-ins ship as TypeScript and Vitest transforms them, so the path an alias names is the file a test
 * reaches by importing `@pithy-sh/ui-react-native/testing/<module>`: one module, one set of controls.
 */

/** This package's `testing/`. Two levels up from this module in `src/testing/` and in `dist/testing/` alike. */
export const NATIVE_TESTING_DIR: string = fileURLToPath(new URL("../../testing/", import.meta.url));

/** A stand-in's absolute path, by its file name under `testing/`. */
const standIn = (file: string): string => join(NATIVE_TESTING_DIR, file);

/**
 * The two specifiers the payments-store stand-in imports the app's own platform files by. The plugin resolves
 * each to a file in the app's source directory.
 */
export const APP_PAYMENTS_STORE = {
  web: "virtual:pithy-app/payments-store",
  native: "virtual:pithy-app/payments-store.native",
} as const;

/** What {@link nativeTestProject} takes. */
export interface NativeTestOptions {
  /** The test files this project runs, as globs from the project root. */
  readonly include: readonly string[];
  /**
   * The directory holding the app's `payments-store.ts` and `payments-store.native.ts`, from the project root or
   * absolute. `src` unless given.
   */
  readonly src?: string;
  /** The project's name in Vitest's output and `--project`. `native` unless given. */
  readonly name?: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The alias rules: each native module to its stand-in, and the store split. */
function aliases(): { find: RegExp; replacement: string }[] {
  return [
    ...Object.entries(STAND_INS).map(([name, file]) => ({
      find: new RegExp(`^${escapeRegExp(name)}$`),
      replacement: standIn(file),
    })),
    // Metro picks `payments-store.native.ts` or `payments-store.ts` by platform; the stand-in picks per call.
    { find: /^\.\/payments-store$/, replacement: standIn("payments-store.ts") },
  ];
}

/** The slice of Vite's plugin context the plugin calls: resolving a specifier as if a given file imported it. */
interface ResolveContext {
  resolve(source: string, importer: string, options: { skipSelf: boolean }): Promise<{ id: string } | null | undefined>;
}

/**
 * The plugin that does what an alias cannot, because each answer depends on the project root, which Vite settles
 * after the config is written.
 *
 * `react-native` resolves to the project's own `react-native-web`, whoever imports it: a kit package under
 * `node_modules` that imports `react-native` gets the copy the screens get, though it may sit where its own
 * resolution would find none. The store stand-in's two imports resolve to the app's own files. And Metro's bare
 * `require.context(` is rewritten to reach `globalThis`, because the module runner hands every module its own
 * `require`, which has no `context`.
 */
function nativePlugin(src: string) {
  let root = process.cwd();
  const appFile = (file: string): string => join(isAbsolute(src) ? src : resolve(root, src), file);
  return {
    name: "pithy-native-testing",
    enforce: "pre" as const,
    configResolved(config: { root: string }): void {
      root = config.root;
    },
    async resolveId(this: ResolveContext, id: string): Promise<{ id: string } | string | null | undefined> {
      if (id === "react-native")
        return this.resolve("react-native-web", join(root, "package.json"), { skipSelf: true });
      if (id === APP_PAYMENTS_STORE.web) return appFile("payments-store.ts");
      if (id === APP_PAYMENTS_STORE.native) return appFile("payments-store.native.ts");
      return undefined;
    },
    transform(code: string): string | undefined {
      return code.includes("require.context(")
        ? code.replaceAll("require.context(", "globalThis.require.context(")
        : undefined;
    },
  };
}

/**
 * A whole Vitest project for React Native screens: happy-dom, `react-native` as `react-native-web`, a stand-in for
 * every native module, Metro's `require.context`, and the two setup files. Spread it into `test.projects`.
 *
 * ```ts
 * export default defineConfig({
 *   test: { projects: [nativeTestProject({ include: ["src/**\/*.test.tsx"] })] },
 * });
 * ```
 */
export function nativeTestProject(options: NativeTestOptions): TestProjectInlineConfiguration {
  return {
    plugins: [nativePlugin(options.src ?? "src")],
    resolve: { alias: aliases() },
    test: {
      name: options.name ?? "native",
      environment: "happy-dom",
      include: [...options.include],
      setupFiles: [standIn("metro.ts"), standIn("reset.ts")],
    },
  };
}
