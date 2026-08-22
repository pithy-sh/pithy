// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { READY_DEADLINE_MS, READY_REMINDER_MS, stillWaitingLines } from "./readyWatch";

/**
 * `docs/commands/dev.md` states the ready deadline in seconds, four times, and an adopter cannot check
 * any of them: they read the page to learn how long `pithy dev` waits before it names a worker, and the
 * only other way to find out is to break a worker and hold a stopwatch. A number that has drifted is
 * worse than no number — it tells someone the session will report in ninety seconds when it will not.
 *
 * This is `project/namingDocs.test.ts` applied to one command's numbers, for the reason CLAUDE.md gives
 * for that file: an adopter-facing number cannot drift from the code. Change `READY_DEADLINE_MS` or
 * `READY_REMINDER_MS` and this fails until the page is changed with it.
 *
 * It lives beside the constants rather than under `commands/`, because the constants do: `pithy dev`'s
 * command module is thin and the deadline belongs to the orchestrator's watch.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PAGE = readFileSync(join(REPO_ROOT, "docs", "commands", "dev.md"), "utf8");
const WHERE = "docs/commands/dev.md";

/**
 * The numbers one sentence of the page states, or a failure naming the sentence that has gone missing.
 *
 * A pin that quietly passes when its regex stops matching is worse than no pin: the sentence it guards
 * can be reworded into a fresh wrong number and nothing notices. So a miss throws, and rewording a
 * pinned sentence is a deliberate act that updates the pattern with it. Copied in shape from
 * `namingDocs.test.ts`'s `stated`, which exists for the drift it caught twice.
 */
function stated(pattern: RegExp, claim: string): number[] {
  const found = PAGE.match(pattern);
  if (!found) throw new Error(`${WHERE} no longer states ${claim} — nothing matched ${pattern}. Repin or restate.`);
  return found.slice(1).map(Number);
}

const DEADLINE_SECONDS = READY_DEADLINE_MS / 1000;
const REMINDER_SECONDS = READY_REMINDER_MS / 1000;

describe("docs/commands/dev.md states the deadline the code enforces", () => {
  test("What it does quotes both numbers, and what the first one is measured from", () => {
    // `after the last worker is spawned` is inside the pattern, not incidental to it. A duration with no
    // origin is not a number an adopter can hold a stopwatch against, and the page said `after startup`
    // while the watch starts after the spawn loop — everything before it, on a cold project tens of
    // seconds of it, was not on the clock. Pinning the phrase is what stops that being written again.
    expect(
      stated(/(\d+) seconds after the last worker is spawned, `pithy dev` says/, "when the first report lands"),
    ).toEqual([DEADLINE_SECONDS]);
    expect(stated(/repeats the line every (\d+) seconds/, "how often the report repeats")).toEqual([REMINDER_SECONDS]);
  });

  test("the `--json` section quotes the same two, for the same watch", () => {
    // Two sections, one timer. They drifted apart in every other doc this repository has pinned, which is
    // why both are read rather than the first one that matches.
    expect(
      stated(
        /Written (\d+) seconds after the last worker is spawned, and every (\d+) seconds after that/,
        "the still-waiting cadence",
      ),
    ).toEqual([DEADLINE_SECONDS, REMINDER_SECONDS]);
  });

  test("the report it quotes is the report the renderer produces", () => {
    // The page pastes `Still waiting on: support.` as the line a developer will see. Asked of
    // `stillWaitingLines` rather than compared against a second copy of the sentence, so rewording the
    // report fails here rather than leaving the page quoting a line the CLI stopped printing.
    expect(PAGE).toContain(stillWaitingLines(["support"], false)[0]);
  });

  test("the `--json` sample is the record the watch emits, for the worker the page names", () => {
    // Keys and values both: `event` is what tells the two `pithy dev` lines apart, so a page that
    // renamed it would be documenting a line no script could recognize.
    const sample = /```json\n(\{"command":"dev","event".*)\n```/.exec(PAGE)?.[1];
    if (sample === undefined) throw new Error(`${WHERE} no longer pastes a still-waiting sample. Repin or restore it.`);
    expect(JSON.parse(sample)).toEqual({ command: "dev", event: "still-waiting", waiting: ["support"] });
  });
});
