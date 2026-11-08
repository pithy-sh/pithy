// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { STAND_INS } from "./standIns";
import { APP_PAYMENTS_STORE, NATIVE_TESTING_DIR, nativeTestProject } from "./vitest";

/** The helpers under `testing/` that stand in for no module: setup, the shared-state helper, the app's types. */
const NOT_A_MODULE = ["metro.ts", "reset.ts", "singleton.ts", "app-modules.d.ts", "payments-store.ts"];

interface Alias {
  find: RegExp;
  replacement: string;
}

interface NativePlugin {
  name: string;
  enforce?: string;
  configResolved(config: { root: string }): void;
  resolveId(this: unknown, id: string): Promise<unknown>;
  transform(code: string): string | undefined;
}

/** The project, its aliases and its one plugin, read the way Vitest reads them. */
function project(options: Parameters<typeof nativeTestProject>[0] = { include: ["src/**/*.test.tsx"] }) {
  const config = nativeTestProject(options);
  const alias = (config.resolve?.alias ?? []) as Alias[];
  const plugins = (config.plugins ?? []) as NativePlugin[];
  const plugin = plugins.find((candidate) => candidate.name === "pithy-native-testing");
  if (plugin === undefined) throw new Error("nativeTestProject returned no pithy-native-testing plugin.");
  return { config, alias, plugin };
}

/** What `specifier` is rewritten to by the first alias that matches it, or `null`. */
function aliased(alias: readonly Alias[], specifier: string): string | null {
  return alias.find((rule) => rule.find.test(specifier))?.replacement ?? null;
}

describe("nativeTestProject", () => {
  test("runs the tests it is given in happy-dom, under the name native unless told otherwise", () => {
    const { config } = project({ include: ["src/**/*.test.tsx", "src/**/*.test.ts"] });
    expect(config.test?.environment).toBe("happy-dom");
    expect(config.test?.include).toEqual(["src/**/*.test.tsx", "src/**/*.test.ts"]);
    expect(config.test?.name).toBe("native");
    expect(project({ include: [], name: "screens" }).config.test?.name).toBe("screens");
  });

  test("loads Metro's require.context and the per-test reset, in that order", () => {
    const { config } = project();
    expect(config.test?.setupFiles).toEqual([
      join(NATIVE_TESTING_DIR, "metro.ts"),
      join(NATIVE_TESTING_DIR, "reset.ts"),
    ]);
    for (const file of config.test?.setupFiles ?? []) expect(existsSync(file), file).toBe(true);
  });

  test("aliases every native module to its stand-in, and the stand-in exists", () => {
    const { alias } = project();
    for (const [name, file] of Object.entries(STAND_INS)) {
      const target = aliased(alias, name);
      expect(target, name).toBe(join(NATIVE_TESTING_DIR, file));
      expect(existsSync(target ?? ""), `${name} → ${target}`).toBe(true);
    }
    // Exact names only: a subpath of a stubbed module is not the module.
    expect(aliased(alias, "expo-router/entry")).toBeNull();
    expect(aliased(alias, "expo-secure-store-extra")).toBeNull();
  });

  test("every stand-in under testing/ is one the project aliases", () => {
    const files = readdirSync(NATIVE_TESTING_DIR).filter((file) => !NOT_A_MODULE.includes(file));
    expect(files.sort()).toEqual(Object.values(STAND_INS).sort());
  });

  test("sends a screen's ./payments-store to the stand-in that picks a platform per call", () => {
    expect(aliased(project().alias, "./payments-store")).toBe(join(NATIVE_TESTING_DIR, "payments-store.ts"));
    expect(aliased(project().alias, "./payments-store.native")).toBeNull();
  });

  test("resolves react-native to the project's own react-native-web, whoever imports it", async () => {
    const { plugin } = project();
    expect(plugin.enforce).toBe("pre");
    plugin.configResolved({ root: "/work/apps/mobile" });
    const asked: unknown[] = [];
    const context = {
      resolve: async (...args: unknown[]) => {
        asked.push(args);
        return { id: "/work/node_modules/react-native-web/dist/index.js" };
      },
    };
    expect(await plugin.resolveId.call(context, "react-native")).toEqual({
      id: "/work/node_modules/react-native-web/dist/index.js",
    });
    expect(asked).toEqual([["react-native-web", "/work/apps/mobile/package.json", { skipSelf: true }]]);
    expect(await plugin.resolveId.call(context, "react-native-web")).toBeUndefined();
  });

  test("resolves the store stand-in's imports to the app's own files, under src unless told otherwise", async () => {
    const { plugin } = project();
    plugin.configResolved({ root: "/work/apps/mobile" });
    expect(await plugin.resolveId.call({}, APP_PAYMENTS_STORE.web)).toBe("/work/apps/mobile/src/payments-store.ts");
    expect(await plugin.resolveId.call({}, APP_PAYMENTS_STORE.native)).toBe(
      "/work/apps/mobile/src/payments-store.native.ts",
    );

    const relative = project({ include: [], src: "templates/src" }).plugin;
    relative.configResolved({ root: "/kit" });
    expect(await relative.resolveId.call({}, APP_PAYMENTS_STORE.web)).toBe("/kit/templates/src/payments-store.ts");

    const absolute = project({ include: [], src: "/elsewhere/src" }).plugin;
    absolute.configResolved({ root: "/kit" });
    expect(await absolute.resolveId.call({}, APP_PAYMENTS_STORE.native)).toBe(
      "/elsewhere/src/payments-store.native.ts",
    );
  });

  test("rewrites Metro's bare require.context to reach globalThis, and leaves other code alone", () => {
    const { plugin } = project();
    expect(plugin.transform('const c = require.context("./routes", true, /x/, "sync");')).toBe(
      'const c = globalThis.require.context("./routes", true, /x/, "sync");',
    );
    expect(plugin.transform("export const x = 1;")).toBeUndefined();
  });

  test("hands each call its own plugin, so two projects never share a root", async () => {
    const one = project().plugin;
    const two = project().plugin;
    one.configResolved({ root: "/a" });
    two.configResolved({ root: "/b" });
    expect(await one.resolveId.call({}, APP_PAYMENTS_STORE.web)).toBe("/a/src/payments-store.ts");
    expect(await two.resolveId.call({}, APP_PAYMENTS_STORE.web)).toBe("/b/src/payments-store.ts");
  });
});
