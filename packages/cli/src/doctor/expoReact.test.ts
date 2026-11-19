// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  checkExpoReact,
  describeExpoReact,
  EXPO_REACT_ACTION,
  expoInstallCommand,
  RENDERER_FILE,
  rendererVersion,
} from "./expoReact";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-expo-react-"));
  await json("package.json", { name: "replay", workspaces: ["apps/*"] });
  await json("apps/api/package.json", { name: "api", dependencies: { hono: "^4.13.2" } });
  await json("apps/app/package.json", {
    name: "app",
    dependencies: { expo: "~57.0.31", react: "^19.2.8", "react-dom": "^19.2.8", "react-native": "0.86.3" },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), JSON.stringify(value));
}

/** `pkg` at `version`, installed under `base`. */
async function installed(base: string, pkg: string, version: string): Promise<void> {
  await json(join(base, "node_modules", pkg, "package.json"), { name: pkg, version });
}

/** React Native, with a renderer that names `renderer` the way the real production build does. */
async function reactNative(base: string, renderer: string): Promise<void> {
  await installed(base, "react-native", "0.86.3");
  const file = join(dir, base, "node_modules", "react-native", RENDERER_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `exports.render=function(){};var internals={bundleType:0,version:"${renderer}",rendererPackageName:"react-native-renderer"};`,
  );
}

describe("rendererVersion", () => {
  test("reads the version the renderer build names", () => {
    expect(rendererVersion('a={bundleType:0, version: "19.2.3", rendererPackageName:"x"}')).toBe("19.2.3");
  });

  test("is null for a file that names none", () => {
    expect(rendererVersion("module.exports = {};")).toBeNull();
  });
});

describe("expoInstallCommand", () => {
  test("pins React and React DOM to the renderer, and @types/react to the kit's range on the kit's renderer", () => {
    expect(expoInstallCommand("19.2.3")).toBe("bunx expo install react@19.2.3 react-dom@19.2.3 @types/react@~19.2.4");
  });

  test("on another renderer, @types/react takes that renderer's minor", () => {
    expect(expoInstallCommand("19.4.1")).toBe("bunx expo install react@19.4.1 react-dom@19.4.1 @types/react@~19.4.0");
  });

  test("leaves React DOM out for an app that has none", () => {
    expect(expoInstallCommand("19.2.3", false)).toBe("bunx expo install react@19.2.3 @types/react@~19.2.4");
  });
});

describe("checkExpoReact", () => {
  test("names an Expo app whose React is not its renderer's, with the command that pins it", async () => {
    await reactNative("apps/app", "19.2.3");
    await installed("apps/app", "react", "19.3.1");
    await installed("apps/app", "react-dom", "19.3.1");

    const check = await checkExpoReact(dir);
    expect(check).toEqual({
      state: "mismatched",
      mismatched: [
        {
          app: "apps/app",
          renderer: "19.2.3",
          react: "19.3.1",
          reactDom: "19.3.1",
          command: "bunx expo install react@19.2.3 react-dom@19.2.3 @types/react@~19.2.4",
        },
      ],
    });
    expect(describeExpoReact(check)).toEqual([
      "apps/app runs React 19.3.1 and React DOM 19.3.1 on React Native's 19.2.3 renderer, which takes React 19.2.3 exactly, so the app will not launch. In apps/app, run `bunx expo install react@19.2.3 react-dom@19.2.3 @types/react@~19.2.4`.",
    ]);
  });

  test("names React DOM alone when React already matches", async () => {
    await reactNative("apps/app", "19.2.3");
    await installed("apps/app", "react", "19.2.3");
    await installed("apps/app", "react-dom", "19.3.1");

    const check = await checkExpoReact(dir);
    expect(check.state).toBe("mismatched");
    expect(describeExpoReact(check)[0]).toMatch(
      /^apps\/app runs React DOM 19\.3\.1 on React Native's 19\.2\.3 renderer/,
    );
  });

  test("passes an Expo app whose React and React DOM equal its renderer", async () => {
    await reactNative("apps/app", "19.2.3");
    await installed("apps/app", "react", "19.2.3");
    await installed("apps/app", "react-dom", "19.2.3");

    expect(await checkExpoReact(dir)).toEqual({ state: "ok", mismatched: [] });
  });

  test("reads what the app resolves, hoisted to the project root included", async () => {
    await reactNative(".", "19.2.3");
    await installed(".", "react", "19.3.1");
    await installed(".", "react-dom", "19.2.3");

    const check = await checkExpoReact(dir);
    expect(check.mismatched.map((app) => [app.app, app.react, app.reactDom])).toEqual([
      ["apps/app", "19.3.1", "19.2.3"],
    ]);
  });

  test("an app not installed yet has nothing to compare", async () => {
    expect(await checkExpoReact(dir)).toEqual({ state: "ok", mismatched: [] });
    await reactNative("apps/app", "19.2.3");
    expect(await checkExpoReact(dir)).toEqual({ state: "ok", mismatched: [] });
  });

  test("a native-only app with no React DOM passes when its React matches", async () => {
    await reactNative("apps/app", "19.2.3");
    await installed("apps/app", "react", "19.2.3");
    expect(await checkExpoReact(dir)).toEqual({ state: "ok", mismatched: [] });
  });

  test("a native-only app with no React DOM is still named when its React does not match", async () => {
    await reactNative("apps/app", "19.2.3");
    await installed("apps/app", "react", "19.3.1");

    const check = await checkExpoReact(dir);
    expect(check).toEqual({
      state: "mismatched",
      mismatched: [
        {
          app: "apps/app",
          renderer: "19.2.3",
          react: "19.3.1",
          reactDom: null,
          command: "bunx expo install react@19.2.3 @types/react@~19.2.4",
        },
      ],
    });
    expect(describeExpoReact(check)).toEqual([
      "apps/app runs React 19.3.1 on React Native's 19.2.3 renderer, which takes React 19.2.3 exactly, so the app will not launch. In apps/app, run `bunx expo install react@19.2.3 @types/react@~19.2.4`.",
    ]);
  });

  test("a React Native with no renderer file is could-not-check, never ok", async () => {
    await installed("apps/app", "react-native", "0.86.3");
    await installed("apps/app", "react", "19.3.1");
    expect(await checkExpoReact(dir)).toEqual({ state: "could-not-check", mismatched: [] });
  });

  test("a renderer that names no version is could-not-check, never ok", async () => {
    await reactNative("apps/app", "19.2.3");
    await writeFile(join(dir, "apps/app/node_modules/react-native", RENDERER_FILE), "module.exports = {};");
    await installed("apps/app", "react", "19.3.1");
    expect(await checkExpoReact(dir)).toEqual({ state: "could-not-check", mismatched: [] });
  });

  test("a renderer that will not open is could-not-check, never ok", async () => {
    await reactNative("apps/app", "19.2.3");
    const file = join(dir, "apps/app/node_modules/react-native", RENDERER_FILE);
    await rm(file);
    await mkdir(file);
    await installed("apps/app", "react", "19.3.1");
    expect(await checkExpoReact(dir)).toEqual({ state: "could-not-check", mismatched: [] });
  });

  test("a mismatch in one app is still named beside an app whose renderer would not read", async () => {
    await json("apps/web/package.json", { name: "web", dependencies: { "react-native": "0.86.3" } });
    await installed("apps/web", "react-native", "0.86.3");
    await installed("apps/web", "react", "19.2.3");
    await reactNative("apps/app", "19.2.3");
    await installed("apps/app", "react", "19.3.1");

    const check = await checkExpoReact(dir);
    expect(check.state).toBe("mismatched");
    expect(check.mismatched.map((app) => app.app)).toEqual(["apps/app"]);
  });

  test("a member that does not depend on React Native is not an Expo app, whatever React it runs", async () => {
    await installed("apps/api", "react", "19.3.1");
    expect(await checkExpoReact(dir)).toEqual({ state: "ok", mismatched: [] });
  });

  test("a project with no Expo app is ok", async () => {
    await rm(join(dir, "apps", "app"), { recursive: true });
    expect(await checkExpoReact(dir)).toEqual({ state: "ok", mismatched: [] });
  });
});

describe("describeExpoReact", () => {
  test("says when the check could not run, and nothing when every app matches", () => {
    expect(describeExpoReact({ state: "ok", mismatched: [] })).toEqual([]);
    expect(describeExpoReact({ state: "could-not-check", mismatched: [] })).toEqual([
      "Could not check the Expo apps' React against their React Native renderer.",
    ]);
  });

  test("the remedy line says the pin is exact", () => {
    expect(EXPO_REACT_ACTION).toMatch(/exactly/);
  });
});
