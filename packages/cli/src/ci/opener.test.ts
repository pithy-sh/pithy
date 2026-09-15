// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, relative, resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { childProcessReport, relativeImports, type SourceModule } from "./childProcesses";
import { isTestFile, readSource, sourcePaths } from "./sourceFiles";

/**
 * **There is one browser opener, one raw-mode reader, and one sentence offering to open a link.**
 *
 * That is the rule, and it is a gate because #607 was one edit away from a second opener. The platform
 * dispatch and the single-key reader both existed — written for `pithy dev`, filed under `dev/`, and
 * therefore invisible to `pithy dashboard`, which needed exactly the same two things. The cheap move
 * from inside `commands/dashboard.ts` was to write `spawn("xdg-open", …)` again, and the version that
 * got written second would have been the one without the Windows title argument, without the detach,
 * or without the scheme check.
 *
 * So the modules moved to where the concern is — `platform/browser.ts` beside `platform/editor.ts`, and
 * `terminal/keys.ts` beside `terminal/output.ts` — and this file says they stayed the only ones.
 *
 * **Each assertion is an enumerated population, not a boolean.** A new offender appears as a new path in
 * a `toEqual`, named, which is `ci/narration.test.ts`'s style and for its reason: a gate that reports
 * `false` tells the next author that something is wrong and nothing about what.
 *
 * **What it does not see**, written down rather than papered over:
 *
 * - **A spawning library.** `execa` or `cross-spawn` opening a browser names no primitive this walk knows.
 *   None is a dependency; `./childProcesses.ts` carries the same hole for the same reason.
 * - **An executable built at runtime.** The command literal is what assertion 2 reads, so
 *   `spawn(["xdg", "open"].join("-"), …)` passes it — but such a module still fails assertion 1, which
 *   reads the text.
 * - **Raw mode reached through something other than `setRawMode`.** There is no other way from Node, but
 *   a native addon would not be seen.
 * - **Anything outside `packages/cli/src`, and `ci/` inside it** — this tree's own gates, which vitest
 *   runs and `pithy` never loads.
 *
 * **The reach was measured in the real tree.** Each of these was planted and went red: a
 * `spawn("open", …)` in `commands/dashboard.ts`, on the spawn rule; the same with `"cmd"`, on the same
 * rule, which is the spelling a Windows-first second opener would use; the same with `"xdg-open"`, on
 * that rule *and* on the text rule; a hand-rolled `process.stdin.setRawMode(true)` in
 * `dev/orchestrator.ts`, and a third importer of `terminal/keys`, both on the reader rule; and a second
 * `"Press k to open the link in the browser."` in `commands/dashboard.ts`, on the sentence rule.
 *
 * One near miss is worth recording: a planted opener that called a *local* `spawnPlant` rather than a
 * `child_process` binding passed the spawn rule, because that walk finds primitives by the module
 * specifier. It failed the text rule, which is why both are here.
 */

/** The repo root, four levels up from `packages/cli/src/ci`. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The CLI's own source. */
const CLI_SRC = resolve(REPO_ROOT, "packages", "cli", "src");

/** The gates' own directory: run by vitest, never by `pithy`. */
const GATES = resolve(CLI_SRC, "ci");

/** The one opener. */
const BROWSER = resolve(CLI_SRC, "platform", "browser.ts");

/** The one raw-mode reader. */
const KEYS = resolve(CLI_SRC, "terminal", "keys.ts");

/** The one composition of the two, and the one other consumer of the reader — `pithy dev`'s `l`. */
const KEY_READERS = [BROWSER, resolve(CLI_SRC, "dev", "orchestrator.ts")];

/** Every spelling of "hand this to the desktop", so a second opener cannot rename its way past this. */
const BROWSER_COMMANDS: ReadonlySet<string> = new Set(["open", "xdg-open", "cmd", "start"]);

/** The offer, as a human reads it. A second phrasing is a second product. */
const OFFER = "to open the link in the browser";

/**
 * A policy for {@link childProcessReport}. Only its `calls` are read here — the narration halves are
 * `ci/narration.test.ts`'s — so this names what that walk needs and decides nothing this file asserts.
 */
const POLICY = {
  boundedExecutables: new Set<string>(),
  uncapturedModules: new Set<string>(),
  progressModule: resolve(CLI_SRC, "terminal", "progress.ts"),
};

/** Every shipped module under `packages/cli/src` outside `ci/`, comments blanked. */
function modules(): Map<string, SourceModule> {
  const found = new Map<string, SourceModule>();
  for (const file of sourcePaths(CLI_SRC)) {
    if (isTestFile(basename(file)) || file.startsWith(`${GATES}/`)) continue;
    const source = readSource(file);
    if (source === null) continue;
    found.set(file, { file, code: blankComments(source) });
  }
  return found;
}

/** A path somebody can open. */
function shown(file: string): string {
  return relative(REPO_ROOT, file);
}

/** The literal executable a call site names, or null when it is an expression. */
function literalExecutable(executable: string): string | null {
  return /^["']([^"']*)["']$/.exec(executable)?.[1] ?? null;
}

describe("one opener, one key reader, one sentence", () => {
  const all = modules();
  const report = childProcessReport(all, POLICY);

  test("this file's idea of where it lives is right, so a miss is a failure and not a silent pass", () => {
    // The anchor every repo-wide gate here carries. A scan rooted at the wrong directory finds nothing
    // and reports success, which is the one outcome worse than a false accusation.
    expect(all.size).toBeGreaterThan(200);
    expect(all.has(BROWSER)).toBe(true);
    expect(all.has(KEYS)).toBe(true);
  });

  test("one module knows what a browser is called", () => {
    const naming = [...all.values()].filter((module) => module.code.includes("xdg-open")).map((module) => module.file);
    expect(naming.map(shown)).toEqual([shown(BROWSER)]);
  });

  test("nothing else spawns a browser, however it spells the command", () => {
    const offenders: string[] = [];
    for (const [file, calls] of report.calls) {
      if (file === BROWSER) continue;
      for (const call of calls) {
        const executable = literalExecutable(call.executable);
        if (executable !== null && BROWSER_COMMANDS.has(executable)) {
          offenders.push(`${shown(file)} ${call.primitive}(${call.executable})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("one module takes the terminal's own handling away, and two argued callers reach it", () => {
    const raw = [...all.values()].filter((module) => module.code.includes("setRawMode")).map((module) => module.file);
    expect(raw.map(shown)).toEqual([shown(KEYS)]);

    // A hand-rolled reader fails the list above; a third consumer fails this one. `pithy dev`'s `l` is
    // the second, and it stays `l`: it mints a credential rather than opening a page, and `o` is taken.
    const importers = [...all.values()]
      .filter((module) => relativeImports(module, all).some((edge) => edge.target === KEYS))
      .map((module) => module.file);
    expect(importers.map(shown).sort()).toEqual(KEY_READERS.map(shown).sort());
  });

  test("one sentence offers to open a link", () => {
    const offering = [...all.values()].filter((module) => module.code.includes(OFFER)).map((module) => module.file);
    expect(offering.map(shown)).toEqual([shown(BROWSER)]);
  });

  /**
   * The reach equals the rule. Every assertion above is a `toEqual` over a set a scan produced, and a
   * scan that has stopped matching anything produces the empty set and passes. These are the lines that
   * say it did not: the walk really found the spawn it exempts, the reader it names, and enough literal
   * executables elsewhere for assertion 2 to have had something to reject.
   */
  test("the walk found what the rules are about, so this measures something", () => {
    expect(report.calls.get(BROWSER)?.map((call) => call.primitive)).toContain("spawn");
    expect(all.get(KEYS)?.code).toContain("setRawMode");
    expect(all.get(BROWSER)?.code).toContain(OFFER);

    const executables = new Set(
      [...report.calls.values()].flat().flatMap((call) => {
        const executable = literalExecutable(call.executable);
        return executable === null ? [] : [executable];
      }),
    );
    expect(executables.size).toBeGreaterThanOrEqual(3);
    expect(executables).toContain("git");
  });
});
