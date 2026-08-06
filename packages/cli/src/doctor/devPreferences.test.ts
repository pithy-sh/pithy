// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devPreferencesPath } from "../seed/prepare";
import { checkDevPreferences, describeDevPreferences } from "./devPreferences";

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-devprefs-"));
  home = await mkdtemp(join(tmpdir(), "pithy-devprefs-home-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** A root `pithy.config.ts` naming this project — the only file the check needs to resolve a path. */
async function project(name: string): Promise<void> {
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: ${JSON.stringify(name)} };\n`);
}

/** The path seams, as a function: `home` is a fresh directory per test, so a captured const would go stale. */
function options(): { platform: "linux"; homedir: string; env: Record<string, string> } {
  return { platform: "linux", homedir: home, env: {} };
}

/** The developer's `dev.json`, written wherever `devPreferencesPath` says it goes. */
async function devJson(name: string, contents: string): Promise<string> {
  const path = devPreferencesPath(name, options());
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  return path;
}

describe("checkDevPreferences", () => {
  test("declines to answer outside a project — no config, no per-project path", async () => {
    expect(await checkDevPreferences(dir, options())).toBeNull();
  });

  test("declines to answer when the config carries no usable name", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    expect(await checkDevPreferences(dir, options())).toBeNull();
  });

  test("reports the resolved path even when there is no file, and calls that absent", async () => {
    await project("acme");
    const check = await checkDevPreferences(dir, options());
    expect(check).toEqual({
      state: "absent",
      path: join(home, ".config", "pithy", "acme", "dev.json"),
      user: null,
    });
  });

  test("reports the user the file names, and never says it is seeded", async () => {
    await project("acme");
    const path = await devJson("acme", '{ "user": "ada@example.com" }\n');
    expect(await checkDevPreferences(dir, options())).toEqual({ state: "ok", path, user: "ada@example.com" });
    expect(describeDevPreferences({ state: "ok", path, user: "ada@example.com" })).not.toMatch(/seed/i);
  });

  test("a file that will not parse is a fault, not an absence — seed reads it as absent and says nothing", async () => {
    await project("acme");
    const path = await devJson("acme", "{ not json");
    expect(await checkDevPreferences(dir, options())).toEqual({ state: "unparseable", path, user: null });
  });

  test("a file that parses but names no user is a fault", async () => {
    await project("acme");
    const path = await devJson("acme", '{ "usr": "ada@example.com" }\n');
    expect(await checkDevPreferences(dir, options())).toEqual({ state: "no-user", path, user: null });
  });

  test("an empty user names nobody", async () => {
    await project("acme");
    const path = await devJson("acme", '{ "user": "" }\n');
    expect(await checkDevPreferences(dir, options())).toEqual({ state: "no-user", path, user: null });
  });

  test("resolves the path seed itself will read, kebabing the name the way seed does", async () => {
    await project("Acme Dash");
    const check = await checkDevPreferences(dir, options());
    expect(check?.path).toBe(devPreferencesPath("acme-dash", options()));
  });

  test("never throws on a config that will not load", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "this is not typescript {{{\n");
    expect(await checkDevPreferences(dir, options())).toBeNull();
  });
});

describe("describeDevPreferences", () => {
  const path = "/home/u/.config/pithy/acme/dev.json";

  test("says nothing is wrong when there is no file", () => {
    expect(describeDevPreferences({ state: "absent", path, user: null })).toBe(
      "none yet; sign-in stays magic-link only",
    );
  });

  test("names the user, and claims nothing more", () => {
    expect(describeDevPreferences({ state: "ok", path, user: "ada@example.com" })).toBe("names ada@example.com");
  });

  test("names both faults in the words of what breaks", () => {
    expect(describeDevPreferences({ state: "unparseable", path, user: null })).toBe(
      "will not parse; seed reads nothing from it",
    );
    expect(describeDevPreferences({ state: "no-user", path, user: null })).toBe(
      'no "user"; seed has nobody to sign in as',
    );
  });
});
