// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { isTestFile, readSource, sourcePaths } from "./sourceFiles";

/**
 * **Every command decides whether to prompt the same way, and the way has three terms.**
 *
 * `!args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)` — `add`, `worker`,
 * `seed`, `ui`, `vector`, `dashboard`, `provision` and `init` each write it, and they agree because
 * every term answers a different question. `--json` because a machine-readable run has a caller that
 * parses one line, and a prompt is not it. **stdin** because that is where an answer would come from.
 * **stdout** because that is where the question goes, and a prompt written into a pipe is a question
 * nobody can see in front of a process that never returns.
 *
 * `secrets` wrote one of the three, and got away with it while the prompt behind the gate was a single
 * answerable text question: a driver under a pty typed a value and the run completed. #516 replaced that
 * with a keyboard-navigated multiselect and one masked prompt per field, and the same driver now hangs —
 * an agent-drivability regression that `docs/CLI.md`'s rule exists to prevent, produced without touching
 * the gate. That is the shape this gate is for: the cost of the missing terms is paid by whoever *later*
 * puts something bigger behind them.
 *
 * **The one exception is written down rather than pattern-matched.** `remove` is human-only and refuses
 * `--json` outright (`rejectJson`), so its gate has nothing to consult — the file is exempted by the
 * call it makes, which means an exception has to be argued in code rather than typed into a list here.
 *
 * **`secrets` has since left this scan, and the reason is the point of the scan rather than a hole in
 * it.** The three-term gate collapses two questions into one, which is right for every command here
 * because none of them reads a document: a pipe on `add`'s stdin means only *no human*. `secrets` reads
 * one, so for it stdin answers *is a document coming* and stdout plus `--json` answer *may I draw a
 * prompt* — and the first remedy for #516 wrote both as the single `interactive`, which made
 * `--json` on a terminal, and any run with stdout redirected to a file, take the *document is piped*
 * branch and silently read the operator's terminal for a credential. So `commands/secrets.ts` now writes
 * only the output half (`canPrompt`) and never touches `process.stdin.isTTY`, which is why nothing here
 * matches it. `commands/secretsInteractive.test.ts` holds both halves, under a real pty, and asserts
 * that this file's regex has nothing to find in `secrets.ts` — so the coverage moved rather than lapsed.
 */

/** The repo root, four levels up from `packages/cli/src/ci`. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** Where a command lives. Nothing outside it defines a `pithy <command>`. */
const COMMANDS = resolve(REPO_ROOT, "packages", "cli", "src", "commands");

/**
 * One expression that consults `process.stdin.isTTY`, as much of it as decides the gate.
 *
 * Bounded by the statement or property it sits in — a `;`, a `}`, or a `,` that ends an object entry —
 * so the two other terms have to be in the same expression rather than anywhere in the file.
 */
const GATE = /[^;{}\n]*process\.stdin\.isTTY[^;}]*/g;

/** Every command source, comments blanked so prose about a TTY is not read as code. */
function commandSources(): { name: string; code: string }[] {
  return sourcePaths(COMMANDS)
    .filter((path) => path.endsWith(".ts") && !isTestFile(basename(path)))
    .flatMap((path) => {
      const source = readSource(path);
      return source === null ? [] : [{ name: basename(path), code: blankComments(source) }];
    });
}

describe("the interactive gate", () => {
  test("is written by more than one command, so this measures something", () => {
    // A scan that matches nothing passes. This is the assertion that says it did not.
    const gates = commandSources().flatMap(({ name, code }) => (code.match(GATE) ?? []).map(() => name));
    expect(new Set(gates).size).toBeGreaterThanOrEqual(6);
  });

  test("asks about stdout as well as stdin, in every command that asks at all", () => {
    const offenders = commandSources().flatMap(({ name, code }) =>
      (code.match(GATE) ?? [])
        .filter((gate) => !gate.includes("process.stdout.isTTY"))
        .map((gate) => `${name}: ${gate.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  test("consults --json, unless the command refuses --json outright", () => {
    const offenders = commandSources().flatMap(({ name, code }) =>
      code.includes("rejectJson(")
        ? []
        : (code.match(GATE) ?? []).filter((gate) => !/\bjson\b/.test(gate)).map((gate) => `${name}: ${gate.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
