// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  defaultState,
  type NotifierState,
  readState,
  setNotifierFlag,
  stateDir,
  stateFilePath,
  writeState,
} from "./state";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("stateDir / stateFilePath", () => {
  test("POSIX default is ~/.config/pithy", () => {
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: {} })).toBe("/home/u/.config/pithy");
    expect(stateFilePath({ platform: "linux", homedir: "/home/u", env: {} })).toBe("/home/u/.config/pithy/state.json");
  });

  test("honors XDG_CONFIG_HOME", () => {
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: { XDG_CONFIG_HOME: "/cfg" } })).toBe("/cfg/pithy");
  });

  test("Windows uses %APPDATA%", () => {
    expect(
      stateDir({ platform: "win32", homedir: "C:\\Users\\u", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } }),
    ).toBe(join("C:\\Users\\u\\AppData\\Roaming", "pithy"));
  });

  test("PITHY_CONFIG_DIR wins over every platform rule, and adds no pithy segment", () => {
    // It IS the pithy config directory, not a config root to nest under: a test harness that points it
    // at a temp directory has to be able to read `<dir>/<project>/secrets.jsonc` back without guessing.
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: { PITHY_CONFIG_DIR: "/run/pithy" } })).toBe(
      "/run/pithy",
    );
    expect(
      stateDir({
        platform: "linux",
        homedir: "/home/u",
        env: { PITHY_CONFIG_DIR: "/run/pithy", XDG_CONFIG_HOME: "/cfg" },
      }),
    ).toBe("/run/pithy");
    expect(
      stateDir({
        platform: "win32",
        homedir: "C:\\Users\\u",
        env: { PITHY_CONFIG_DIR: "D:\\pithy", APPDATA: "C:\\x" },
      }),
    ).toBe(resolve("D:\\pithy"));
  });

  test("a relative PITHY_CONFIG_DIR is made absolute, and an empty one is no override", () => {
    // Every error the secrets file raises names its absolute path, so the resolver may not hand out a
    // relative one that means a different directory in every command that resolves its own cwd.
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: { PITHY_CONFIG_DIR: "cfg" } })).toBe(resolve("cfg"));
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: { PITHY_CONFIG_DIR: "  " } })).toBe(
      "/home/u/.config/pithy",
    );
  });
});

describe("readState", () => {
  test("missing file → safe default", async () => {
    expect(await readState(join(dir, "nope.json"))).toEqual(defaultState());
  });

  test("malformed JSON → safe default, never throws", async () => {
    const file = join(dir, "state.json");
    await writeFile(file, "{ not json");
    expect(await readState(file)).toEqual(defaultState());
  });

  test("schema-invalid payload → safe default", async () => {
    const file = join(dir, "state.json");
    await writeFile(file, JSON.stringify({ lastCheck: "yesterday", installer: "cargo" }));
    expect(await readState(file)).toEqual(defaultState());
  });

  test("honors a hand-edited notifier:false", async () => {
    const file = join(dir, "state.json");
    await writeState(file, { ...defaultState(), notifier: false });
    expect((await readState(file)).notifier).toBe(false);
  });
});

describe("writeState", () => {
  test("round-trips through the schema and creates the directory", async () => {
    const file = join(dir, "nested", "state.json");
    const state: NotifierState = {
      lastCheck: 1_700_000_000_000,
      latestVersion: "1.3.0",
      installer: "bun",
      notifier: true,
      securityFlagged: false,
    };
    await writeState(file, state);
    expect(await readState(file)).toEqual(state);
    // Written as pretty JSON with a trailing newline.
    expect(await readFile(file, "utf8")).toMatch(/\n$/);
  });
});

describe("setNotifierFlag", () => {
  test("flips the flag while preserving other fields", async () => {
    const file = join(dir, "state.json");
    await writeState(file, { lastCheck: 42, latestVersion: "1.2.0", installer: "npm", notifier: true });
    await setNotifierFlag(file, false);
    const after = await readState(file);
    expect(after.notifier).toBe(false);
    expect(after.lastCheck).toBe(42);
    expect(after.latestVersion).toBe("1.2.0");
    await setNotifierFlag(file, true);
    expect((await readState(file)).notifier).toBe(true);
  });

  test("creates the file from the default when none exists yet", async () => {
    const file = join(dir, "state.json");
    await setNotifierFlag(file, false);
    expect(await readState(file)).toEqual({ ...defaultState(), notifier: false });
  });
});
