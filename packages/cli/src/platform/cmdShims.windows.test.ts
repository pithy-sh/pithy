// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { requireWindows } from "../test-utils/windows";
import { runEditor } from "./editor";

requireWindows();

/**
 * **What a `.cmd` takes to run on Windows, from Node** — the fact #698 and every fix for it build on.
 *
 * This does not drive the CLI's package-manager spawn, which is still broken on Windows (#698); the fix for
 * that brings its own `*.windows.test.ts`, and this job is what runs it.
 *
 * The package managers and most editors are `.cmd` shims on Windows. Since the April 2024 fix for
 * CVE-2024-27980, Node refuses to spawn a `.cmd` or `.bat` without a shell, so the obvious repair — spawn
 * `npm.cmd` instead of `npm` — fails with `EINVAL` on every Node the CLI supports. Running one through
 * `cmd.exe` works, and every argument then has to survive `cmd.exe` re-splitting the command line, which
 * is what `runEditor`'s quoting is for (`docs/ACCEPTED-LIMITS.md` §Windows runs the editor through a shell).
 *
 * The shim lives in a directory with a space in its name, because a Windows home directory with a space
 * in it is the common case and the quoting is exactly what breaks there.
 */

const run = promisify(execFile);

let dir: string;
let shim: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy windows "));
  shim = join(dir, "record-args.cmd");
  // Writes its arguments, exactly as cmd.exe handed them over, beside itself.
  await writeFile(shim, '@echo off\r\n>"%~dp0args.txt" echo %*\r\n');
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("a .cmd spawned from Node", () => {
  test("is refused without a shell, with EINVAL, thrown before any promise exists", () => {
    // Synchronous, and that matters to every caller: `spawn` throws this from the call itself, where a
    // missing binary's `ENOENT` arrives later as an `error` event. Code that only listens for the event —
    // `pithy dev`'s orchestrator does — does not catch it. Measured here on the first Windows run (#702).
    let thrown: unknown;
    try {
      // Should it ever settle as a promise instead, the rejection is caught here and the assertion fails.
      run(shim, ["install"]).catch(() => undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "EINVAL", syscall: "spawn" });
  });

  test("runs through cmd.exe with runEditor's quoting, and a path with a space arrives whole", async () => {
    const file = join(dir, "secrets file.jsonc");
    await writeFile(file, "{}\n");

    const code = await runEditor({ command: shim, args: [], source: "EDITOR" }, file);

    expect(code).toBe(0);
    expect((await readFile(join(dir, "args.txt"), "utf8")).trim()).toBe(`"${file}"`);
  });
});
