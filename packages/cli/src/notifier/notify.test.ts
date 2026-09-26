// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FetchLike } from "./check";
import { formatUpdateNotice, runUpdateNotifier, shouldNotify } from "./notify";
import { defaultState, type NotifierState, readState, writeState } from "./state";

/** A visible, ANSI-free accent so tests can assert which tokens are accented without color codes. */
const mark = (s: string): string => `«${s}»`;

/** The `.tmp` siblings `writeFileAtomic` holds mid-write — named, so a failure says which one survived. */
async function tempsIn(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

/** One macrotask, so every pending microtask has drained before a "still pending" assertion is made. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-notify-"));
  file = join(dir, "state.json");
});
/**
 * Teardown is a gate here, not a courtesy (#658).
 *
 * `force: true` was on the `rm` and it hid the one failure that mattered. The directory always exists, so
 * `force` swallowed no `ENOENT` worth swallowing — what it could not swallow was `rmdir`'s `ENOTEMPTY`,
 * which is what a `state.json.<hex>.tmp` created *after* the recursive walk's `readdir` snapshot produces.
 * That is a test returning while the notifier's write is still in flight, and it failed a release at random
 * rather than saying so. So: the survivors are listed first, and named in the assertion; the removal is
 * allowed to throw, because a directory this suite cannot remove is a result.
 */
afterEach(async () => {
  const survivors = await tempsIn(dir);
  await rm(dir, { recursive: true });
  expect(survivors, "a write was still in flight when the test returned").toEqual([]);
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
  // The command literal here is a change-detector for the notice's shape, not a gate on the command being
  // right. What each installer's command must be TRUE of lives in `installer.test.ts`.
  test("minor form: two lines with the installer's update command", () => {
    const notice = formatUpdateNotice({
      installed: "1.2.0",
      latest: "1.3.0",
      installer: "bun",
      bump: "minor",
      accent: mark,
    });
    expect(notice).toBe(
      ["", "pithy «1.3.0» «available». You have 1.2.0.", "Update: bun install -g @pithy-sh/cli"].join("\n"),
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
    const settled = runUpdateNotifier({
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
    // The returned promise, not the fetch. The fetch is the job's *first* observable step; the state
    // write that follows it is the last durable one, and teardown is what races that (#658).
    await settled;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await readState(file)).latestVersion).toBe("1.3.0");
    expect(await tempsIn(dir)).toEqual([]);
  });

  test("the promise is the state write, not the fetch: it stays pending while the write is held open", async () => {
    await writeState(file, base);

    // Hold `writeFileAtomic` open exactly where the real one is vulnerable: the temp file exists, the
    // rename has not happened. No timing anywhere — the write finishes only when this test releases it,
    // so neither assertion below can pass for the wrong reason.
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reportOpen: (() => void) | undefined;
    const isOpen = new Promise<void>((resolve) => {
      reportOpen = resolve;
    });

    vi.resetModules();
    vi.doMock("../project/atomic", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../project/atomic")>();
      return {
        ...actual,
        writeFileAtomic: async (path: string, content: string): Promise<void> => {
          const tmp = `${path}.0123456789abcdef.tmp`;
          await writeFile(tmp, content);
          reportOpen?.();
          await released;
          await rename(tmp, path);
        },
      };
    });

    try {
      const { runUpdateNotifier: fresh } = await import("./notify");
      const fetch = okFetch("1.3.0");
      const settled = fresh({
        installedVersion: "1.2.0",
        stateFile: file,
        fetch,
        now: () => 5_000_000_000,
        isTTY: true,
        stderr: () => {},
        schedule: (fn) => fn(),
      });
      let done = false;
      void settled.then(() => {
        done = true;
      });

      await isOpen;
      // This is where the old test returned: the fetch has happened, so the wait it made was satisfied —
      // and a temp file is sitting in the directory teardown is about to try to remove.
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await tempsIn(dir)).toHaveLength(1);
      await tick();
      expect(done, "settled before its own write landed").toBe(false);

      release?.();
      await settled;
      expect(done).toBe(true);
      expect(await tempsIn(dir)).toEqual([]);
      expect((await readState(file)).latestVersion).toBe("1.3.0");
    } finally {
      vi.doUnmock("../project/atomic");
      vi.resetModules();
    }
  });

  test("stale cache → fetches, persists, and prints a minor notice", async () => {
    await writeState(file, base);
    const writes: string[] = [];
    await runUpdateNotifier({
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
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("pithy «1.3.0» «available». You have 1.2.0.");
    // State persisted with the new version.
    expect((await readState(file)).latestVersion).toBe("1.3.0");
  });

  test("fresh cache → no fetch, but still notifies off the cached version", async () => {
    const now = () => 5_000_000_000;
    await writeState(file, { ...base, lastCheck: now(), latestVersion: "1.3.0" });
    const fetch = okFetch("9.9.9");
    const writes: string[] = [];
    await runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: file,
      fetch,
      now,
      isTTY: true,
      stderr: (t) => writes.push(t),
      schedule: (fn) => fn(),
      accent: mark,
    });
    expect(writes.length).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(writes[0]).toContain("«1.3.0»"); // cached, not the 9.9.9 the network would have returned
  });

  test("network failure is silent and writes no notice", async () => {
    await writeState(file, base);
    const fetch: FetchLike = async () => {
      throw new Error("offline");
    };
    const writes: string[] = [];
    await runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: file,
      fetch,
      now: () => 5_000_000_000,
      isTTY: true,
      stderr: (t) => writes.push(t),
      schedule: (fn) => fn(),
    });
    expect(writes).toEqual([]);
  });

  test("a corrupt state file yields the safe default and never throws", async () => {
    await writeFile(file, "{ broken");
    const writes: string[] = [];
    let settled: Promise<void> | undefined;
    // Synchronously, because the throw this rules out would be a synchronous one: `bin.ts` calls this
    // without a `try`, so a notice must not be able to take a command's exit code with it.
    expect(() => {
      settled = runUpdateNotifier({
        installedVersion: "1.2.0",
        stateFile: file,
        fetch: okFetch("1.3.0"),
        now: () => 5_000_000_000,
        isTTY: true,
        stderr: (t) => writes.push(t),
        schedule: (fn) => fn(),
        accent: mark,
      });
    }).not.toThrow();
    await expect(settled).resolves.toBeUndefined();
    expect(writes.length).toBe(1);
  });

  test("patch bump does not notify; security-flagged patch does", async () => {
    // Distinct state files, still: each job is awaited before the next starts now, but two writes aimed at
    // one file is a race the next edit reintroduces for free.
    const plainFile = join(dir, "plain.json");
    const flaggedFile = join(dir, "flagged.json");

    // Plain patch → suppressed.
    await writeState(plainFile, base);
    const plain: string[] = [];
    await runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: plainFile,
      fetch: okFetch("1.2.1"),
      now: () => 5_000_000_000,
      isTTY: true,
      stderr: (t) => plain.push(t),
      schedule: (fn) => fn(),
    });
    expect(plain).toEqual([]);

    // Security-flagged patch → notifies.
    await writeState(flaggedFile, base);
    const flagged: string[] = [];
    await runUpdateNotifier({
      installedVersion: "1.2.0",
      stateFile: flaggedFile,
      fetch: okFetch("1.2.1", { "pithy:security": true }),
      now: () => 5_000_000_000,
      isTTY: true,
      stderr: (t) => flagged.push(t),
      schedule: (fn) => fn(),
      accent: mark,
    });
    expect(flagged.length).toBe(1);
    expect(flagged[0]).toContain("«1.2.1»");
  });
});
