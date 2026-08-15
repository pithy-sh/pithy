// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CommandDef } from "citty";
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
 * fails `pithy && next` and fails a CI step. Every group took the same path for the same reason.
 *
 * The complement is the half that must keep working: `pithy nonsense` is a mistake, not a question, and
 * still names what it did not recognise and still exits non-zero. So is `pithy valueOf`, which is not a
 * name anybody typed on purpose but is a name every object literal answers to.
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

/**
 * How many subcommands the root declares, and how many of those are groups.
 *
 * Exact, and stated here rather than left to a floor. The population guard was
 * `expect(names.length).toBeGreaterThan(5)` against a root declaring twenty-seven — so a regression that
 * lost twenty groups was a passing test. A number a new command forces somebody to look at is the point:
 * the module's own prose had already drifted to "thirteen groups" while the tree held fourteen.
 */
const DECLARED = 27;
const GROUPS = 14;

/**
 * Every root subcommand, split into the groups and the commands that act.
 *
 * **Read from the command tree's declaration, never from `usageTarget`.** The list used to be built by
 * keeping a name only `if (await usageTarget(main, [name]))` — the function these tests exist to check —
 * so a regression that made the walk miss a group deleted that group from the list rather than failing
 * on it. The rule is stated here in its own words instead: a group is a command that declares
 * subcommands and has no way to act on its own, which is what a reader of `main.ts` and the group files
 * sees. Nothing below consults the walk to decide what the walk should have done.
 *
 * **The twenty-seven loads are overlapped, and that is the fix for #361, not a tidy-up.** This function
 * is the whole body of the first case in this file — the sum of its `load()` calls and that case's
 * reported duration agree to within 3ms — and each `load()` is a dynamic import that pulls a command
 * module and its transitive half of the CLI through vite. Awaited one at a time, the case paid twenty-
 * seven independent trips through the scheduler, so machine contention did not add to its cost, it
 * *multiplied* into it: measured on this box under a real parallel load (load average 12–17), the serial
 * loop ran **4,039 / 4,701 / 12,215 / 15,622 ms** — a **3.9x spread on identical code**, against the
 * config's 30,000ms default. A case whose tail is 15.6s under a 30s budget is not flaky; it is
 * arithmetic, and `bun run test` runs twenty-three packages at `--concurrency=50%`, which is a heavier
 * load than any of those four samples.
 *
 * Overlapped into one `Promise.all`, the same work waits once instead of twenty-seven times: **3,235 /
 * 3,521 / 3,690 / 3,735 ms** under the same load — a **1.15x spread**, and an 8x margin. Nothing about
 * what is asserted changed. The loads are independent, each command is classified from its own module
 * alone, and `Promise.all` preserves declaration order, so `groups` and `acting` come back in the order
 * `main.ts` writes them exactly as before.
 *
 * **Overlapping was necessary and was not sufficient**, which is why the case also carries an explicit
 * ceiling now — see the `120_000` on it below, and the reason written there.
 */
async function classify(): Promise<{ declared: string[]; groups: string[]; acting: string[] }> {
  const subCommands = (await main.subCommands) as Record<string, () => Promise<CommandDef>>;
  const declared = Object.keys(subCommands);
  const groups: string[] = [];
  const acting: string[] = [];
  const verdicts = await Promise.all(
    Object.entries(subCommands).map(async ([name, load]) => {
      const cmd = await load();
      const nested = typeof cmd.subCommands === "function" ? await cmd.subCommands() : await cmd.subCommands;
      const dispatches = nested !== undefined && Object.keys(nested).length > 0;
      const actsOnItsOwn = typeof cmd.run === "function" || cmd.default !== undefined;
      return { name, isGroup: dispatches && !actsOnItsOwn };
    }),
  );
  for (const { name, isGroup } of verdicts) (isGroup ? groups : acting).push(name);
  return { declared, groups, acting };
}

describe("the command tree these rules are checked over", () => {
  test("splits into groups and acting commands, wholly and at its real size", async () => {
    const { declared, groups, acting } = await classify();
    // Total: every declared name lands on exactly one side. A classification that quietly dropped names
    // would shrink both sides, and every assertion built on them would weaken with it.
    expect([...groups, ...acting].sort()).toEqual([...declared].sort());
    expect(declared).toHaveLength(DECLARED);
    expect(groups).toHaveLength(GROUPS);
    expect(acting).toHaveLength(DECLARED - GROUPS);
    // **120s is a hang ceiling, not the margin this case lives in, and it is the second half of #361.**
    // The case is expected to take about 3.5s: that is what `classify()` costs with its loads overlapped,
    // measured four times standalone under a real parallel load. What it was running against was the
    // config's 30,000ms *default* — a number nobody chose for this case, applied to it by omission, while
    // the two cases below it in this same file, which do strictly more work, were each given 120_000
    // explicitly. That asymmetry was the whole defect.
    //
    // The measurement that settles the size. `bun run test --force` — twenty-three packages at
    // `--concurrency=50%`, which is the command the issue is about — was run on this box at load average
    // 66. This file took **182,914ms**, against ~24,000ms for the same file standalone at load 14: a
    // **7.5x** whole-file contention factor, far past the 2.8x that `dashboard#63` measured. 3.5s through
    // that factor is ~26s, and the run recorded this case at **30,103ms**, killed by the 30s default. So
    // the default sits *inside* the case's real operating range, which is what makes it a trap rather
    // than a limit.
    //
    // 120_000 is ~34x the expected cost and ~4x the worst the heaviest load on this machine produced.
    // Nothing is expected to approach it; a case that does has hung, which is the only thing a timeout
    // should ever be asked to catch. It is also simply what its siblings in this file already declare —
    // this brings the odd one out into line rather than inventing a number.
  }, 120_000);
});

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

  test("the walk answers every declared group, and no command that acts", async () => {
    const { groups, acting } = await classify();
    const missed: string[] = [];
    for (const name of groups) if ((await usageTarget(main, [name])) === null) missed.push(name);
    expect(missed).toEqual([]);
    // The other half of the rule, on the same population: a command that acts is citty's, and answering
    // it with usage would be a command that stopped running.
    const hijacked: string[] = [];
    for (const name of acting) if ((await usageTarget(main, [name])) !== null) hijacked.push(name);
    expect(hijacked).toEqual([]);
  });

  test("the same rule one level down — every group, not a sample of them", async () => {
    const { groups } = await classify();
    for (const name of groups) {
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

/**
 * A name every object literal answers to is not a command.
 *
 * `subCommands` is an object literal at every level of the tree, so `Object.prototype` is in scope for
 * any lookup that does not ask for an own name. `pithy valueOf` called `Object.prototype.valueOf` with
 * no receiver and died on a raw `TypeError` under a crash banner; `pithy constructor` called `Object`,
 * took the `{}` it handed back for a command definition, ran nothing, and exited **0**. Neither is a
 * command. Both belong on the path `pithy nonsense` takes.
 */
const INHERITED = ["valueOf", "hasOwnProperty", "constructor", "toString", "isPrototypeOf", "__proto__"];

describe("an inherited name is not a command", () => {
  test("the walk resolves none of them, and throws on none of them", async () => {
    const resolved: string[] = [];
    for (const name of INHERITED) if ((await usageTarget(main, [name])) !== null) resolved.push(name);
    expect(resolved).toEqual([]);
    const nested: string[] = [];
    for (const name of INHERITED) if ((await usageTarget(main, ["secrets", name])) !== null) nested.push(name);
    expect(nested).toEqual([]);
  });

  test("each one is refused by name and exits non-zero, at the root and one level down", async () => {
    for (const name of INHERITED) {
      const root = await pithy(name);
      expect(`${name}: ${root.stdout}${root.stderr}`).toContain(name);
      expect(`${name}: exit ${root.code}`).not.toBe(`${name}: exit 0`);
      const group = await pithy("secrets", name);
      expect(`secrets ${name}: ${group.stdout}${group.stderr}`).toContain(name);
      expect(`secrets ${name}: exit ${group.code}`).not.toBe(`secrets ${name}: exit 0`);
    }
  }, 120_000);
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
