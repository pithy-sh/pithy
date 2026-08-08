// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

/**
 * #200. **Under vitest, this resolver refuses to answer with the operator's own machine.**
 *
 * One `bun run test` left 36 directories in a maintainer's real `~/.config/pithy`, each holding a
 * genuinely minted AES master key, and wrote `SECRETS_STORE_ID` into their real `cloudflare.json`.
 * `addBootstrap.test.ts` passed no `paths` seam, so `bootstrapAdd` resolved the real directory, and
 * nothing anywhere said no.
 *
 * The repo-root `vitest.setup.ts` is the floor: every test gets a throwaway `PITHY_CONFIG_DIR`. This is
 * the thing the floor cannot do. A safe default still lets a test opt back into the real directory by
 * accident — one `vi.stubEnv`, one curated env map, one suite that clears the variable — and it does so
 * silently, because a real path looks exactly like a fake one. A resolver that refuses cannot.
 *
 * **What counts as an answer the caller chose:** `PITHY_CONFIG_DIR`, or the seam. `process.env` is the
 * operator's shell and `os.homedir()` is their home directory; neither is chosen by a test, so neither
 * is reachable from one. Nothing here fires outside vitest, so a real `pithy` run is untouched.
 */
describe("stateDir under vitest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** No override, no injected environment, nothing chosen — the exact shape `addBootstrap.test.ts` had. */
  function noSeam(): void {
    vi.stubEnv("PITHY_CONFIG_DIR", "");
  }

  test("no seam at all is a refusal, not the operator's directory", () => {
    noSeam();
    const thrown = (() => {
      try {
        return stateDir();
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(PithyError);
    // The message has to name the fix, because whoever sees it wrote a test and not this file.
    expect((thrown as PithyError).payload.message).toContain("PITHY_CONFIG_DIR");
    expect((thrown as PithyError).payload.action).toContain("PITHY_ALLOW_REAL_CONFIG_DIR");
  });

  test("an injected environment is not enough when the answer still comes from the real home", () => {
    // The environment is the caller's, the home directory is the machine's. `XDG_CONFIG_HOME` unset is
    // the ordinary case on macOS, so this is the branch a forgetful test lands on.
    expect(() => stateDir({ platform: "linux", env: {} })).toThrow(PithyError);
    expect(() => stateDir({ platform: "win32", env: {} })).toThrow(PithyError);
  });

  test("a synthetic answer is fine — nothing real was reached", () => {
    // No home directory is consulted on either of these branches, so there is nothing to refuse.
    expect(stateDir({ platform: "linux", env: { XDG_CONFIG_HOME: "/cfg" } })).toBe("/cfg/pithy");
    expect(stateDir({ platform: "win32", env: { APPDATA: "C:\\x" } })).toBe(join("C:\\x", "pithy"));
  });

  test("the seam satisfies it, in both of its spellings", () => {
    noSeam();
    expect(stateDir({ env: { PITHY_CONFIG_DIR: "/run/pithy" } })).toBe("/run/pithy");
    expect(stateDir({ platform: "linux", homedir: "/home/u", env: {} })).toBe("/home/u/.config/pithy");
  });

  test("the floor under every suite: the setup file's directory is the answer, unasked", () => {
    // `vitest.setup.ts` at the repo root sets this before a test file is imported, which is why the
    // twelve hundred tests that never think about it still resolve somewhere disposable.
    const configured = process.env.PITHY_CONFIG_DIR;
    expect(configured).toBeTruthy();
    expect(stateDir()).toBe(configured);
    // The shape the setup file mints, asserted rather than assumed. A developer who exports
    // `PITHY_CONFIG_DIR` in their own shell would otherwise satisfy the two lines above without the
    // setup file having run at all, and this test is the one that says it did.
    expect(configured).toContain(join(tmpdir(), "pithy-test-config-"));
  });

  test("an integration suite that means the real directory says so, once, out loud", () => {
    noSeam();
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("PITHY_ALLOW_REAL_CONFIG_DIR", "1");
    expect(stateDir({ platform: "linux" })).toBe(join(homedir(), ".config", "pithy"));
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
