// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { requireWindows } from "../test-utils/windows";
import { systemExecutable } from "./killTree";
import { detectShell, PROFILE_ARGS } from "./shell";

requireWindows();

/**
 * #708, on a Windows host: `pithy alias` writes each PowerShell edition's profile where that edition
 * says it is. The Windows runner has both editions — 5.1 ships with Windows and `pwsh` 7 is on its
 * image — so each one is asked here directly, outside the CLI, and the resolved set must name exactly
 * those files. A redirected `Documents` is the case this exists for, and on a machine that has one,
 * this is the test that sees it.
 */

/** What an edition prints for `$PROFILE`, asked by the test itself, with the module's own argv. */
function profileOf(executable: string): string {
  const run = spawnSync(executable, PROFILE_ARGS, {
    encoding: "utf8",
    windowsHide: true,
  });
  expect(run.status, `${executable} exited ${run.status}: ${run.stderr}`).toBe(0);
  return run.stdout.trim();
}

describe("the PowerShell profile set on Windows", () => {
  // Four cold PowerShell starts, two of them 5.1: seconds each on a fresh runner, so not the 5s default.
  test("names each edition's own $PROFILE: 7 first, then 5.1", { timeout: 60_000 }, async () => {
    const seven = profileOf("pwsh");
    const five = profileOf(systemExecutable("WindowsPowerShell/v1.0/powershell"));
    const shell = await detectShell({ shell: "", platform: "win32" });
    expect(shell?.rcPath).toBe(seven);
    expect(shell?.extraRcPaths).toEqual(five === seven ? [] : [five]);
  });
});
