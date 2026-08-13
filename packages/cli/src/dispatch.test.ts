// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { usageTarget } from "./dispatch";
import { main } from "./main";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");

/**
 * **A command that names no action is asking what it can do, and being answered is a success.**
 *
 * One rule, checked over the whole command tree rather than over the two commands #319 happened to name.
 * Bare `pithy` printed a complete command list and then argued with the user under it — `No command
 * specified.`, plus `error: script "pithy" exited with code 1` from bun's wrapper — and exited 1, which
 * fails `pithy && next` and fails a CI step. Thirteen groups took the same path for the same reason.
 *
 * The complement is the half that must keep working: `pithy nonsense` is a mistake, not a question, and
 * still names what it did not recognise and still exits non-zero.
 */

/** Spawn the real bin and report both streams and the exit status, never throwing on a non-zero exit. */
async function pithy(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], {
      env: { ...process.env, PITHY_NO_UPDATE_NOTIFIER: "1" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** Every command group the root declares — the set the rule has to hold over, not a sample of it. */
async function groups(): Promise<string[]> {
  const subCommands = (await main.subCommands) as Record<string, () => Promise<{ subCommands?: unknown }>>;
  const found: string[] = [];
  for (const [name, load] of Object.entries(subCommands)) {
    const target = await usageTarget(main, [name]);
    if (target) found.push(name);
    void load;
  }
  return found;
}

describe("a command that names no action", () => {
  test("bare pithy prints the help, says nothing after it, and succeeds", async () => {
    const { code, stdout, stderr } = await pithy();
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain("doctor");
    // The two lines that followed the help. The first was citty arguing with a user it had just served;
    // the second was bun's wrapper concluding for a CLI that had exited 1.
    expect(`${stdout}${stderr}`).not.toContain("No command specified");
    expect(code).toBe(0);
  });

  test("the same rule one level down — every group, not a sample of them", async () => {
    const names = await groups();
    // If this list ever empties, the walk stopped resolving and every assertion below is vacuous.
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      const { code, stdout, stderr } = await pithy(name);
      expect(`${name}: ${stdout}`).toContain("USAGE");
      expect(`${name}: ${stdout}${stderr}`).not.toContain("No command specified");
      expect(`${name}: exit ${code}`).toBe(`${name}: exit 0`);
    }
  }, 120_000);

  test("an unknown command is still a mistake — named, and non-zero", async () => {
    const { code, stdout, stderr } = await pithy("nonsense");
    expect(`${stdout}${stderr}`).toContain("nonsense");
    expect(stdout).toContain("USAGE");
    expect(code).not.toBe(0);
  });

  test("an unknown subcommand of a real group is a mistake too", async () => {
    const { code, stdout, stderr } = await pithy("secrets", "nonsense");
    expect(`${stdout}${stderr}`).toContain("nonsense");
    expect(code).not.toBe(0);
  });
});

describe("the walk itself", () => {
  test("a command that acts is citty's, at either level", async () => {
    // `doctor` runs; `secrets list` runs. Neither is a question, so neither is answered with usage.
    expect(await usageTarget(main, ["doctor"])).toBeNull();
    expect(await usageTarget(main, ["secrets", "list"])).toBeNull();
  });

  test("an unknown name is handed back untouched, so citty names it", async () => {
    expect(await usageTarget(main, ["nonsense"])).toBeNull();
    expect(await usageTarget(main, ["secrets", "nonsense"])).toBeNull();
  });

  test("a group reached with only flags is still a group naming no action", async () => {
    expect(await usageTarget(main, ["secrets", "--json"])).not.toBeNull();
  });

  test("the root resolves to itself, with no parent to prefix its usage line", async () => {
    const target = await usageTarget(main, []);
    expect(target?.cmd).toBe(main);
    expect(target?.parent).toBeUndefined();
  });

  test("a group resolves with the root as its parent, so the usage line reads `pithy secrets`", async () => {
    const target = await usageTarget(main, ["secrets"]);
    expect(target?.parent).toBe(main);
  });
});
