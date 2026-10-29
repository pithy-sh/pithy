// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { APP_TOKEN, TEMPLATE_DIR, TEMPLATE_GROUPS, WORKER_TOKEN } from "@pithy-sh/ui-react-native/src/templates";
import { describe, expect, test } from "vitest";
import { kitRange } from "../project/scaffold";
import { reactNativeStub } from "./reactNative";
import type { UiStubContext } from "./stubs";
import { loadStubFiles } from "./templates";

/** The repo root, four levels up from `packages/cli/src/ui`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** A workspace package's manifest, read from its own `package.json`. */
async function manifestOf(name: string): Promise<{ version: string; devDependencies: Record<string, string> }> {
  const path = join(REPO_ROOT, "packages", name.slice("@pithy-sh/".length), "package.json");
  return JSON.parse(await readFile(path, "utf8")) as { version: string; devDependencies: Record<string, string> };
}

const BARE: UiStubContext = {
  worker: "api",
  app: "app",
  auth: false,
  payments: false,
  organization: false,
  consent: false,
  mcp: false,
  packageManager: "bun",
};
const EVERYTHING: UiStubContext = { ...BARE, auth: true, payments: true, organization: true, consent: true, mcp: true };

/** Whether `version` is one `range` admits, for the three shapes the stub writes: exact, `~` and `^`. */
function admits(range: string, version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = range.replace(/^[~^]/, "").split(".").map(Number);
  const [vMajor = 0, vMinor = 0, vPatch = 0] = version.split(".").map(Number);
  if (range.startsWith("~")) return vMajor === major && vMinor === minor && vPatch >= patch;
  if (range.startsWith("^")) {
    if (major > 0) return vMajor === major && (vMinor > minor || (vMinor === minor && vPatch >= patch));
    return vMajor === 0 && vMinor === minor && vPatch >= patch;
  }
  return range === version;
}

describe("the react-native stub's manifest", () => {
  test("is pure: the same context gives the same files", () => {
    expect(reactNativeStub.manifest(EVERYTHING)).toEqual(reactNativeStub.manifest(EVERYTHING));
  });

  test("the bare scaffold is the base group and the bare home screen, written where the auth one would be", () => {
    const files = reactNativeStub.manifest(BARE);
    expect(files.map((file) => file.target)).toEqual([...TEMPLATE_GROUPS.base, "src/routes/app/home.tsx"]);
    expect(files.at(-1)).toEqual({ source: "src/routes/app/home.bare.tsx", target: "src/routes/app/home.tsx" });
  });

  test("the screen sets stack, and none of them is written twice", () => {
    const targets = reactNativeStub.manifest(EVERYTHING).map((file) => file.target);
    for (const group of ["auth", "payments", "organization", "consent", "mcp"] as const) {
      for (const path of TEMPLATE_GROUPS[group]) expect(targets, path).toContain(path);
    }
    expect(new Set(targets).size).toBe(targets.length);
  });

  test("the agent screens ride on mcp alone", () => {
    const withoutMcp = reactNativeStub.manifest({ ...EVERYTHING, mcp: false }).map((file) => file.target);
    for (const path of TEMPLATE_GROUPS.mcp) expect(withoutMcp).not.toContain(path);
  });

  test("every file it can write is on disk in the template library", async () => {
    for (const file of reactNativeStub.manifest(EVERYTHING)) {
      await expect(access(join(TEMPLATE_DIR, file.source)), file.source).resolves.toBeUndefined();
    }
  });

  test("the worker and the app names replace their tokens, and no token survives a scaffold", async () => {
    expect(reactNativeStub.substitutions(BARE)).toEqual({ [WORKER_TOKEN]: "api", [APP_TOKEN]: "app" });
    const files = await loadStubFiles(reactNativeStub, BARE);
    for (const [path, contents] of Object.entries(files)) {
      expect(contents, path).not.toContain(WORKER_TOKEN);
      expect(contents, path).not.toContain(APP_TOKEN);
    }
  });
});

describe("the react-native stub's packages", () => {
  test("every third-party pin admits the version @pithy-sh/ui-react-native checks the templates against", async () => {
    const checked = (await manifestOf("@pithy-sh/ui-react-native")).devDependencies;
    let compared = 0;
    for (const [name, range] of Object.entries(reactNativeStub.dependencies)) {
      const version = checked[name];
      if (name.startsWith("@pithy-sh/") || version === undefined || range === null) continue;
      compared += 1;
      expect(admits(range, version.replace(/^[~^]/, "")), `${name}: ${range} against ${version}`).toBe(true);
    }
    expect(compared, "compared no pin at all").toBeGreaterThanOrEqual(15);
  });

  test("React Native 0.86 on Expo SDK 57, with React held at the repository's 19.2.8", () => {
    expect(reactNativeStub.dependencies).toMatchObject({
      "react-native": "0.86.3",
      expo: "~57.0.31",
      react: "^19.2.8",
      "react-dom": "^19.2.8",
      "react-native-web": "~0.21.0",
    });
  });

  test("core and i18n take core's own range, the release train they ship on", () => {
    expect(reactNativeStub.dependencies["@pithy-sh/core"]).toBe(kitRange(PACKAGE_VERSION));
    expect(reactNativeStub.dependencies["@pithy-sh/i18n"]).toBe(kitRange(PACKAGE_VERSION));
  });

  test("ui-core takes its own version, not core's", async () => {
    expect(reactNativeStub.dependencies["@pithy-sh/ui-core"]).toBe(
      kitRange((await manifestOf("@pithy-sh/ui-core")).version),
    );
  });

  test("every package a template imports is declared, or is a kit package the flow finds a range for", async () => {
    const declared = new Set([
      ...Object.keys(reactNativeStub.dependencies),
      ...Object.keys(reactNativeStub.devDependencies),
    ]);
    let seen = 0;
    for (const file of reactNativeStub.manifest(EVERYTHING)) {
      if (!/\.tsx?$/.test(file.source)) continue;
      const contents = blankComments(await readFile(join(TEMPLATE_DIR, file.source), "utf8"));
      for (const match of contents.matchAll(/from "((?:@[a-z0-9-]+\/)?[a-z0-9-]+)/g)) {
        const pkg = match[1] ?? "";
        seen += 1;
        expect(
          declared.has(pkg) || pkg.startsWith("@pithy-sh/"),
          `${file.source} imports ${pkg}, and the app's package.json declares nothing for it`,
        ).toBe(true);
      }
    }
    expect(seen, "the import sweep read nothing").toBeGreaterThanOrEqual(30);
  });
});

describe("the react-native stub's dev and build commands", () => {
  /** The Expo CLI that the Expo SDK the templates are checked against runs. */
  async function expoCliSource(path: string): Promise<string> {
    const fromApp = createRequire(join(REPO_ROOT, "packages", "ui-react-native", "package.json"));
    const fromExpo = createRequire(fromApp.resolve("expo/package.json"));
    return readFile(join(dirname(fromExpo.resolve("@expo/cli/package.json")), path), "utf8");
  }

  test("the ready signal matches the line the installed Expo CLI prints when Metro listens with no terminal", async () => {
    const source = await expoCliSource("build/src/start/startAsync.js");
    // Printed through chalk, which styles the URL and leaves the words as they are.
    expect(source).toContain("`Waiting on {underline ");
    const signal = new RegExp(reactNativeStub.readySignal);
    expect(signal.test("Waiting on http://localhost:8790")).toBe(true);
    expect(signal.test("Waiting on \u001b[4mhttp://localhost:8790\u001b[24m")).toBe(true);
    expect(signal.test("Starting project at /home/you/replay/apps/app")).toBe(false);
  });

  test("the build is Expo's web export", () => {
    expect(reactNativeStub.buildCommand).toEqual(["expo", "export", "--platform", "web"]);
  });
});
