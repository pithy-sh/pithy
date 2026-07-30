// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FetchLike } from "./check";
import { formatUpdateNotice, runUpdateNotifier, shouldNotify } from "./notify";
import { defaultState, type NotifierState, readState, writeState } from "./state";

/** A visible, ANSI-free accent so tests can assert which tokens are accented without color codes. */
const mark = (s: string): string => `«${s}»`;

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-notify-"));
  file = join(dir, "state.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function okFetch(version: string, extra: Record<string, unknown> = {}): FetchLike {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version, ...extra }) }));
}

const on: Omit<Parameters<typeof shouldNotify>[0], "bump" | "securityFlagged"> = {
  isTTY: true,
  env: {},
  notifierEnabled: true,
};

describe("shouldNotify", () => {
  test("minor and major notify", () => {
    expect(shouldNotify({ ...on, bump: "minor", securityFlagged: false })).toBe(true);
    expect(shouldNotify({ ...on, bump: "major", securityFlagged: false })).toBe(true);
  });

  test("a plain patch is suppressed; a security-flagged patch notifies", () => {
    expect(shouldNotify({ ...on, bump: "patch", securityFlagged: false })).toBe(false);
    expect(shouldNotify({ ...on, bump: "patch", securityFlagged: true })).toBe(true);
  });

  test("none never notifies", () => {
    expect(shouldNotify({ ...on, bump: "none", securityFlagged: true })).toBe(false);
  });

  test("non-TTY stderr suppresses entirely", () => {
    expect(shouldNotify({ ...on, isTTY: false, bump: "major", securityFlagged: false })).toBe(false);
  });

  test("PITHY_NO_UPDATE_NOTIFIER suppresses entirely", () => {
    expect(shouldNotify({ ...on, env: { PITHY_NO_UPDATE_NOTIFIER: "1" }, bump: "major", securityFlagged: false })).toBe(
      false,
    );
  });

  test("notifier flag off suppresses", () => {
    expect(shouldNotify({ ...on, notifierEnabled: false, bump: "minor", securityFlagged: false })).toBe(false);
  });
});

describe("formatUpdateNotice", () => {
  test("minor form: two lines with the installer's update command", () => {
    const notice = formatUpdateNotice({
      installed: "1.2.0",
      latest: "1.3.0",
      installer: "bun",
      bump: "minor",
      accent: mark,
    });
    expect(notice).toBe(
      ["", "pithy «1.3.0» «available». You have 1.2.0.", "Update: bun update -g @pithy-sh/cli"].join("\n"),
    );
  });

  test("accents the version and the word available", () => {
    const notice = formatUpdateNotice({
      installed: "1.2.0",
      latest: "1.3.0",
      installer: "npm",
      bump: "minor",
      accent: mark,
    });
    expect(notice).toContain("«1.3.0»");
    expect(notice).toContain("«available»");
  });

  test("major form adds the changelog pointer and note", () => {
    const notice = formatUpdateNotice({
      installed: "1.4.0",
      latest: "2.0.0",
      installer: "brew",
      bump: "major",
      accent: mark,
    });
    expect(notice).toBe(
      [
        "",
        "pithy «2.0.0» «available». You have 1.4.0. (Major release — see changelog.)",
        "Update: brew upgrade pithy",
        "Changelog: https://pithy.sh/changelog/2.0",
      ].join("\n"),
    );
  });

  test("NO_COLOR drops the accent but still prints the text", async () => {
    // Re-evaluate the style seam with NO_COLOR set so the real `saffron` latches to plain.
    vi.stubEnv("NO_COLOR", "1");
    vi.resetModules();
    const { formatUpdateNotice: fresh } = await import("./notify");
    const notice = fresh({ installed: "1.2.0", latest: "1.3.0", installer: "npm", bump: "minor" });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ESC byte is absent
    expect(notice).not.toMatch(/\x1b\[/);
    expect(notice).toContain("1.3.0 available");
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("runUpdateNotifier", () => {
  const base: NotifierState = { ...defaultState(), installer: "bun", lastCheck: 0 };

  test("is non-blocking: nothing runs until the scheduled job fires", async () => {
    await writeState(file, base);
    const fetch = okFetch("1.3.0");
    let job: (() => void) | undefined;
    runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: file,
      fetch,
      now: () => 5_000_000_000,
      isTTY: true,
      stderr: () => {},
      schedule: (fn) => {
        job = fn;
      },
    });
    // Synchronously after the call, no network has happened.
    expect(fetch).not.toHaveBeenCalled();
    expect(job).toBeTypeOf("function");
    job?.();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  test("stale cache → fetches, persists, and prints a minor notice", async () => {
    await writeState(file, base);
    const writes: string[] = [];
    runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: file,
      fetch: okFetch("1.3.0"),
      now: () => 5_000_000_000,
      isTTY: true,
      env: {},
      stderr: (t) => writes.push(t),
      schedule: (fn) => fn(),
      accent: mark,
    });
    await vi.waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toContain("pithy «1.3.0» «available». You have 1.2.0.");
    // State persisted with the new version.
    expect((await readState(file)).latestVersion).toBe("1.3.0");
  });

  test("fresh cache → no fetch, but still notifies off the cached version", async () => {
    const now = () => 5_000_000_000;
    await writeState(file, { ...base, lastCheck: now(), latestVersion: "1.3.0" });
    const fetch = okFetch("9.9.9");
    const writes: string[] = [];
    runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: file,
      fetch,
      now,
      isTTY: true,
      stderr: (t) => writes.push(t),
      schedule: (fn) => fn(),
      accent: mark,
    });
    await vi.waitFor(() => expect(writes.length).toBe(1));
    expect(fetch).not.toHaveBeenCalled();
    expect(writes[0]).toContain("«1.3.0»"); // cached, not the 9.9.9 the network would have returned
  });

  test("network failure is silent and writes no notice", async () => {
    await writeState(file, base);
    const fetch: FetchLike = async () => {
      throw new Error("offline");
    };
    const writes: string[] = [];
    runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: file,
      fetch,
      now: () => 5_000_000_000,
      isTTY: true,
      stderr: (t) => writes.push(t),
      schedule: (fn) => fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes).toEqual([]);
  });

  test("a corrupt state file yields the safe default and never throws", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ broken");
    const writes: string[] = [];
    expect(() =>
      runUpdateNotifier({
        installedVersion: "1.2.0",
        stateFile: file,
        fetch: okFetch("1.3.0"),
        now: () => 5_000_000_000,
        isTTY: true,
        stderr: (t) => writes.push(t),
        schedule: (fn) => fn(),
        accent: mark,
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(writes.length).toBe(1));
  });

  test("patch bump does not notify; security-flagged patch does", async () => {
    // Distinct state files so the two fire-and-forget jobs never race on one file.
    const plainFile = join(dir, "plain.json");
    const flaggedFile = join(dir, "flagged.json");

    // Plain patch → suppressed.
    await writeState(plainFile, base);
    const plain: string[] = [];
    runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: plainFile,
      fetch: okFetch("1.2.1"),
      now: () => 5_000_000_000,
      isTTY: true,
      stderr: (t) => plain.push(t),
      schedule: (fn) => fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(plain).toEqual([]);

    // Security-flagged patch → notifies.
    await writeState(flaggedFile, base);
    const flagged: string[] = [];
    runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: flaggedFile,
      fetch: okFetch("1.2.1", { "pithy:security": true }),
      now: () => 5_000_000_000,
      isTTY: true,
      stderr: (t) => flagged.push(t),
      schedule: (fn) => fn(),
      accent: mark,
    });
    await vi.waitFor(() => expect(flagged.length).toBe(1));
    expect(flagged[0]).toContain("«1.2.1»");
  });
});
