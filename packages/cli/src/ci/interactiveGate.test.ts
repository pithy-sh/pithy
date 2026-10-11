// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, relative, resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { isTestFile, readSource, sourcePaths } from "./sourceFiles";

/**
 * **Whether a run may ask anybody anything is decided in one place: `terminal/inputMode.ts`.**
 *
 * This gate used to hold the opposite rule. Each command wrote its own
 * `!args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)`, and the gate checked
 * that every copy carried all three terms — because `secrets` once wrote one of the three, and the cost
 * of a missing term was paid by whoever later put a bigger prompt behind it (#516).
 *
 * Every copy was right about its terms and wrong about its premise. A TTY does not prove a person is
 * present: an agent harness that allocates a PTY and runs without `--json` passed all three and waited
 * on a question nobody would answer. The fix is a fourth term — `PITHY_NONINTERACTIVE=1` and `--no-input`
 * — and a fourth term written into fifteen copies is fifteen chances to miss one. So the copies are gone
 * (#697): `mayPrompt`, `mayDraw`, `mayReadKeys` and `stdinTakesInput` are the seam, and nothing else in
 * `src/` reads `process.stdin.isTTY`. The three terms still matter, and `terminal/inputMode.test.ts`
 * holds the seam to every one of them.
 *
 * **stdin is the stream this scans for**, because it is the one only an interactivity decision reads.
 * Stdout's `isTTY` is also read to shape output (`style.ts`, `bin.ts`), which is not a question about a
 * person and stays where it is.
 *
 * `secrets` keeps its two-question split through the seam: `mayDraw` asks stdout alone, and whether a
 * document is arriving is the stdin *stream's* own `isTTY`, read by `readSecretValue` off the stream it
 * is handed. `commands/secretsInteractive.test.ts` holds that half.
 */

/** The CLI's source root. */
const SRC = resolve(import.meta.dirname, "..");

/** The one module allowed to read stdin's TTY-ness. */
const SEAM = resolve(SRC, "terminal", "inputMode.ts");

/** A read of stdin's TTY-ness, the raw material of every hand-written interactivity gate. */
const STDIN_TTY = /process\.stdin\.isTTY/;

/** What a caller of the seam writes. */
const SEAM_CALL = /\b(?:mayPrompt|mayDraw|mayReadKeys|stdinTakesInput|inputForbidden)\(/;

/** Every shipped source under `src/`, comments blanked so prose about a TTY is not read as code. */
function shippedSources(): { path: string; code: string }[] {
  return sourcePaths(SRC)
    .filter((path) => (path.endsWith(".ts") || path.endsWith(".tsx")) && !isTestFile(basename(path)))
    .flatMap((path) => {
      const source = readSource(path);
      return source === null ? [] : [{ path, code: blankComments(source) }];
    });
}

/** The files that read stdin's TTY-ness outside the seam, as `src`-relative paths. */
function offenders(sources: readonly { path: string; code: string }[]): string[] {
  return sources
    .filter(({ path, code }) => path !== SEAM && STDIN_TTY.test(code))
    .map(({ path }) => relative(SRC, path));
}

describe("the interactivity seam", () => {
  test("is the only module that reads process.stdin.isTTY", () => {
    expect(offenders(shippedSources())).toEqual([]);
  });

  test("reads it itself, so the rule above is about a real read and not an empty file", () => {
    const seam = shippedSources().find(({ path }) => path === SEAM);
    expect(seam?.code).toMatch(/process\.stdin/);
  });

  test("is what the commands call, in enough places that this measures something", () => {
    // A seam nobody calls would pass the rule above trivially. Commands, platform helpers and the dev
    // renderer all ask it; fewer than this many callers means a site went back to deciding for itself.
    const callers = shippedSources().filter(({ path, code }) => path !== SEAM && SEAM_CALL.test(code));
    expect(callers.length).toBeGreaterThanOrEqual(15);
    const commands = callers.filter(({ path }) => relative(SRC, path).startsWith("commands/"));
    expect(commands.length).toBeGreaterThanOrEqual(12);
  });

  test("a hand-written gate is caught — the planted defect this scan exists for", () => {
    const planted = [
      {
        path: resolve(SRC, "commands", "planted.ts"),
        code: "const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);",
      },
      { path: SEAM, code: "return Boolean(process.stdin.isTTY);" },
    ];
    expect(offenders(planted)).toEqual(["commands/planted.ts"]);
  });
});
