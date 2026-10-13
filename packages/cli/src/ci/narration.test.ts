// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, relative, resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import {
  boundedExecutableName,
  type ChildProcessPolicy,
  type ChildProcessReport,
  childProcessReport,
  interpretersIn,
  relativeImports,
  type SourceModule,
} from "./childProcesses";
import { isTestFile, readSource, sourcePaths } from "./sourceFiles";

/**
 * **Every captured child process a `pithy` command starts runs under a step naming what it is for, and
 * `--json` emits exactly one line** — but for `deploy` and `provision` under `--json --events` (#697), which
 * emit each step as a record and close the stream with that one line. That exception is held at runtime by
 * `terminal/progress.test.ts` and `commands/deploy.test.ts`; nothing here changes for it.
 *
 * That is the invariant, and it is stated over a *set this file discovers* rather than over the commands
 * #578 was reported against. The reason is that report's own finding: #531 built the narration for
 * `pithy provision`, named it for provisioning, and put it in `provision/`, so nothing about it said *this
 * is how a long command narrates itself* — and the next long command, `deploy`, printed nothing at all for
 * minutes while it shipped Workers.
 *
 * **The population is found through the spawn primitives, not a wrapper's name (#593).** This gate first
 * looked for `runWrangler(` and claimed every captured subprocess. It had one wrapper's callers.
 * `bun add` under `pithy add`, `<pm> install` under `pithy worker add` and `pithy feature create` ran
 * through `execFile` and ran silent, and none of them was in the population. `./childProcesses.ts` now
 * finds every binding a module obtains from `child_process` — however it is imported, aliased, namespaced,
 * destructured or `promisify`'d — and walks outward, declaration by declaration and across modules, to
 * whatever raises a step. Its docblock has the parsing.
 *
 * **Three halves, because silence has three causes.**
 *
 * 1. *The walk.* Every use of `child_process` it meets must be one it can follow. A binding passed as a
 *    value, a re-export, a specifier held in a variable fail here, naming the file, rather than being
 *    skipped — and so does a relative `import()` whose specifier is built at runtime from a literal. This is
 *    the half that keeps the reach equal to the claim.
 * 2. *The producer.* A top-level declaration that starts a captured child — or calls one that does — raises
 *    a step, or is called by something that does. What reaches a `pithy <command>` module still silent is the
 *    defect.
 * 3. *The command.* A step reaches a terminal only inside a narrated span, and every command body goes
 *    through one wrapper — `withErrorReporting`, which takes `json` and, from `deploy` and `provision`, the
 *    `--events` stream to narrate into instead. So a command that reaches a narrating producer must route its
 *    body through it, which is also where the `--json` half is decided: `commandProgress({ json: true })` is no
 *    sink, and `eventsProgress` is the one sink a `--json` run can have. `terminal/progress.test.ts` holds both
 *    at runtime.
 *
 * **Not every child needs a step, and there are two exceptions.** A child whose executable is written as the
 * literal `"git"`, `"lsof"`, `"ps"` or `"taskkill"` (the last via `systemExecutable`) is bounded local work —
 * git's metadata, the process table, a short kill — judged at the call site, so the same `execFile` with
 * `"npm"` beside it is held. Those four are bounded everywhere because each is a single-purpose tool. An
 * interpreter is bounded only in a module named for it, with the reason (`ChildProcessPolicy`'s docblock
 * states the rule): PowerShell in `dev/ports.ts`, for its two CIM queries, and in `platform/shell.ts`, for
 * its `$PROFILE` query. And a streams-on spawn in one of
 * three named modules — the editor that owns the terminal, the browser opener that detaches, and the dev
 * orchestrator that pipes each worker's streams to the terminal and the session log — is not captured.
 * Streams-on means the `spawn` primitive, and its #698 spelling through the shared command spawner,
 * `spawnCommand`: an `execFile` in any of them is held like anywhere else, and so is every captured
 * child in the spawner's other callers, each counted at its own call site.
 * The spawner itself (`platform/command.ts`) is exempt by a third rule: the spawn *inside* it is the
 * mechanism, not a call site, and every `spawnCommand`/`execCommand` call in its callers is counted as
 * a spawn where it is written. The spawner's exemption exempts one file; it exempts nobody who calls it.
 *
 * **Where silence is reported.** A declaration that reaches a child without a step passes that on to whatever
 * names it, so the defect surfaces where a run begins: a `pithy <command>` module, or `bin.ts` and `main.ts`,
 * which run before any command is chosen. A chain that ends at a step anywhere along the way is narrated.
 *
 * **What it does not see.** Every hole is written here rather than papered, because a gate that claims more
 * than it covers is the defect this file was rewritten for.
 *
 * - **A bounded executable doing unbounded work.** `"git"` is judged by the executable, never the argv. A
 *   planted `run("git", ["fetch", "--all"])` in `feature/worktree.ts` passed.
 * - **A captured `spawn` in an uncaptured module.** A planted `spawn("npm", ["install"], { stdio: "pipe" })`
 *   in `platform/editor.ts` passed.
 * - **Order and wording.** A step anywhere in a declaration narrates every child it reaches, before or after
 *   the spawn and whatever the step names.
 * - **A seam called by value, and anything else reached without its name.** A declaration reaches another
 *   when it names it. `options.install ?? runPackageManager` names the default where it is used, which is
 *   how every seam here is written; a default assigned in one place and called through a parameter somewhere
 *   the name never appears is not followed, and nor is a silent chain that `commands/`, `bin.ts` and `main.ts`
 *   never name.
 * - **What `./childProcesses.ts` lists**: a specifier assembled at runtime, a spawning library, `cluster.fork`,
 *   and a relative module imported through a variable or a `require` — `await import(spec)` reaching a
 *   silent spawner was planted in a command and passed.
 * - **Anything outside `packages/cli/src`, and `ci/` inside it.** The repo's `scripts/worktree.ts` runs its
 *   install with `stdio: "inherit"`, so it streams rather than hides; it is not held here either way. `ci/` is
 *   this tree's own gates, which vitest runs and `pithy` never reaches.
 * - **A command that is slow without spawning anything (#583).** A remote D1 statement, a KV put, an R2
 *   upload is a REST round trip, and a command made of hundreds of them passes every assertion here while
 *   printing nothing. `pithy migrate` and `pithy seed` were exactly that. They are held by their own runtime
 *   gates, which hand a run its stores through the run's seams and require every round trip to follow a
 *   step naming its store: `migrations/narration.test.ts` for everything through `runGroups` (migrate,
 *   rollback, `seed --redo`'s reset, `remove --drop`) and `seed/narration.test.ts` for the seed writes.
 *   **Nothing holds any other REST-bound command.** One written next year that loops over
 *   `cloudflareClients` — or an existing one that grows a loop — is silent, and no test here or there fails.
 *   No needle was found that names "this is slow" without also naming every one-shot API call in the CLI,
 *   so the hole is stated rather than papered.
 *
 * **The reach was measured in the real tree, spelled differently from every producer in it.** Each of these
 * was planted and went red: an `execFile` imported `as ef` in `worker remove`; `import * as cp` and
 * `cp.execFileSync` in `remove`'s steps; `runWrangler` imported `as wr` into `worker rename`; the same reached
 * by destructuring `import * as wrangler`; `util.promisify` over a destructured, renamed dynamic import in
 * `feature create`; `child_process` imported through a template literal; a silent spawner in `dev/ports.ts`
 * reached from a command by `` await import(`../dev/ports`) ``, red as a silent command, and by
 * `` import(`../dev/${"ports"}`) ``, red as an unfollowable import; an `execFileSync` in the help renderer that
 * only `bin.ts` reaches; the step deleted from `runPackageManager`; and `execFile` exported as a value.
 * `./childProcesses.test.ts` keeps every spelling as a fixture, so the parser cannot lose one quietly.
 */

/** The repo root, four levels up from `packages/cli/src/ci`. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The CLI's own source — every module that could spawn anything. */
const CLI_SRC = resolve(REPO_ROOT, "packages", "cli", "src");

/** Where a command lives. Nothing outside it defines a `pithy <command>`. */
const COMMANDS = resolve(CLI_SRC, "commands");

/**
 * What runs before any command is chosen: the binary, and the table that loads a command. A child started
 * here runs under every `pithy` invocation, and it is a command's silence as much as one in `commands/`.
 */
const ENTRIES = new Set(["bin.ts", "main.ts"].map((path) => resolve(CLI_SRC, path)));

/** The gates' own directory: run by vitest, never by `pithy`. */
const GATES = resolve(CLI_SRC, "ci");

/** The one wrapper that installs a narrated span, and the only thing that consults `--json` for it. */
const WRAP = /\bwithErrorReporting\s*\(/;

/** What needs no step. Each entry is argued in the docblock above. */
const POLICY: ChildProcessPolicy = {
  boundedExecutables: new Set(["git", "lsof", "ps", "taskkill"]),
  moduleBoundedExecutables: new Map([
    [
      resolve(CLI_SRC, "dev", "ports.ts"),
      new Map([
        [
          "WindowsPowerShell/v1.0/powershell",
          "Two CIM queries on Windows, with fixed argv and a pid or port as a number literal: which pid listens on a dev port, and that pid's command line and parent.",
        ],
      ]),
    ],
    [
      resolve(CLI_SRC, "platform", "shell.ts"),
      new Map([
        ["pwsh", "One `$PROFILE` query to PowerShell 7, with fixed argv, `-NoProfile` and a ten-second timeout."],
        [
          "WindowsPowerShell/v1.0/powershell",
          "One `$PROFILE` query to Windows PowerShell 5.1, with fixed argv, `-NoProfile` and a ten-second timeout.",
        ],
      ]),
    ],
  ]),
  uncapturedModules: new Set(
    ["platform/browser.ts", "platform/editor.ts", "dev/orchestrator.ts"].map((path) => resolve(CLI_SRC, path)),
  ),
  progressModule: resolve(CLI_SRC, "terminal", "progress.ts"),
  // The shared command spawner (#698): its seam calls are spawns **at their call sites**, counted in
  // each caller rather than exempted as a module, so the next caller cannot borrow the exemption.
  // The streams-on exemption then reads the seam call exactly as it read the raw `spawn` it replaced:
  // the dev orchestrator pipes its workers' streams to the terminal and the session log, which is why
  // `dev/orchestrator.ts` joins the list — the child streams, so it needs no step.
  commandSpawner: resolve(CLI_SRC, "platform", "command.ts"),
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

/** Every module reachable from `entry` through relative value imports, `entry` included. */
function reachable(entry: string, all: Map<string, SourceModule>): Set<string> {
  const seen = new Set<string>([entry]);
  const stack = [entry];
  while (stack.length > 0) {
    const module = all.get(stack.pop() as string);
    if (!module) continue;
    for (const edge of relativeImports(module, all)) {
      if (seen.has(edge.target)) continue;
      seen.add(edge.target);
      stack.push(edge.target);
    }
  }
  return seen;
}

/** The modules a key set's declarations live in. */
function filesOf(keys: ReadonlySet<string>, report: ChildProcessReport): Set<string> {
  return new Set([...keys].map((key) => report.declarations.get(key)?.file as string));
}

describe("a long command narrates itself", () => {
  const all = modules();
  const report = childProcessReport(all, POLICY);

  test("the walk follows every use of child_process, and every relative dynamic import, it meets", () => {
    expect(report.unfollowable.map((entry) => entry.replace(`${REPO_ROOT}/`, ""))).toEqual([]);
  });

  test("the walk finds the spawn sites, so this measures something", () => {
    // Not `> 0`, which is the shape of a guard rather than an assertion. Every module that starts a child
    // today, found by its primitive. A new one joins the population on the day it is written.
    expect([...report.calls.keys()].map(shown).sort()).toEqual([
      "packages/cli/src/dev/orchestrator.ts",
      "packages/cli/src/dev/ports.ts",
      "packages/cli/src/feature/ports.ts",
      "packages/cli/src/feature/worktree.ts",
      "packages/cli/src/plan/shadow.ts",
      "packages/cli/src/platform/browser.ts",
      "packages/cli/src/platform/editor.ts",
      "packages/cli/src/platform/killTree.ts",
      "packages/cli/src/platform/shell.ts",
      "packages/cli/src/project/deploy.ts",
      "packages/cli/src/project/packageManager.ts",
      "packages/cli/src/project/templateFiles.ts",
      "packages/cli/src/project/wrangler.ts",
    ]);
  });

  test("each exception still describes a module that starts a child", () => {
    for (const file of POLICY.uncapturedModules) {
      expect(
        // Streams-on, in either spelling: the raw `spawn`, and its #698 seam `spawnCommand`.
        report.calls.get(file)?.some((call) => call.primitive === "spawn" || call.primitive === "spawnCommand"),
        shown(file),
      ).toBe(true);
    }
    const executables = [...report.calls.values()]
      .flat()
      .map((call) => boundedExecutableName(call.executable) ?? call.executable.replace(/^["']|["']$/g, ""));
    for (const executable of POLICY.boundedExecutables) expect(executables, executable).toContain(executable);
    for (const [file, entries] of POLICY.moduleBoundedExecutables ?? []) {
      // The module first, so a moved or mistyped key says which module, not only which spelling.
      expect(report.calls.has(file), `${shown(file)} starts no child, so its bounded entry bounds nothing`).toBe(true);
      const spelled = (report.calls.get(file) ?? []).map((call) => boundedExecutableName(call.executable));
      for (const [executable, reason] of entries) {
        expect(reason.trim(), `${shown(file)} ${executable} names no reason`).not.toBe("");
        expect(spelled, `${shown(file)} ${executable} (${reason})`).toContain(executable);
      }
    }
  });

  test("no interpreter is bounded in every module", () => {
    // An interpreter runs whatever it is handed, so its call is bounded only where someone read the
    // script: a `moduleBoundedExecutables` entry, never the global set (#734).
    expect(interpretersIn(POLICY.boundedExecutables)).toEqual([]);
  });

  /**
   * The producer half. Silence that reaches a `pithy <command>` module is the defect #578 and #593 report,
   * whatever module the child was started in.
   */
  test("every captured child a command reaches runs under a step", () => {
    const silent = [...report.silent]
      .map((key) => report.declarations.get(key))
      .filter((decl) => decl !== undefined && (decl.file.startsWith(`${COMMANDS}/`) || ENTRIES.has(decl.file)))
      .map((decl) => `${shown(decl?.file as string)} ${decl?.name}`);
    // Each entry names what made it reach a child, so a failure can be walked back to the spawn.
    const trail = [...report.silent].map((key) => `${shown(key)} ${report.because.get(key)}`).sort();

    expect(silent, trail.join("\n")).toEqual([]);
  });

  /**
   * The command half. A step raised inside a producer reaches a terminal only inside a narrated span, and
   * `withErrorReporting` is the only thing in this CLI that opens one.
   */
  test("every command that can reach a narrating producer opens a narrated span", () => {
    const narrating = filesOf(report.narrated, report);
    const enrolled = [...all.values()]
      .filter((module) => module.file.startsWith(`${COMMANDS}/`))
      .filter((command) => [...reachable(command.file, all)].some((file) => narrating.has(file)));

    // Anti-vacuity, exact about the floor rather than the membership: `deploy` is the command #578 was
    // reported against, and `add` and `worker` are two #593 found. A population that had collapsed to one
    // would pass a set test and mean nothing.
    expect(enrolled.length).toBeGreaterThanOrEqual(8);
    expect(enrolled.map((command) => basename(command.file))).toEqual(
      expect.arrayContaining(["deploy.ts", "add.ts", "worker.ts", "feature.ts"]),
    );

    expect(enrolled.filter((command) => !WRAP.test(command.code)).map((command) => shown(command.file))).toEqual([]);
  });
});
