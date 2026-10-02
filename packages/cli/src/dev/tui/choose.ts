// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { isContinuousIntegration } from "@pithy-sh/core/src/env/ci";

/**
 * The facts the renderer choice turns on, passed in rather than read here.
 *
 * Explicit because this is the one decision that governs whether a session repaints at all, and reading
 * `process` inside it would make every clause testable only by mutating globals. `commands/dev.ts`
 * gathers these once and hands them over.
 */
export interface RendererInputs {
  /** Whether the footer has a terminal to render into. */
  stdoutIsTTY: boolean;
  /** Whether there is a keyboard to read. Separate from stdout: `pithy dev < /dev/null` has one and not the other. */
  stdinIsTTY: boolean;
  json: boolean;
  /** `isContinuousIntegration()` — any non-blank `CI`. */
  ci: boolean;
  /** `TERM`. `dumb` is a terminal telling us it cannot do this. */
  term: string | undefined;
  /** `PITHY_NO_TUI` — the standing preference, for a terminal that renders the footer badly. */
  noTui: string | undefined;
  /**
   * `--tui` / `--no-tui`, as the command declared it. Defaults true.
   *
   * **A flag as well as the variable, because a variable nobody can find is not an escape hatch.**
   * `PITHY_NO_TUI` does not appear in `--help`, so the only way to learn it exists is to read the docs —
   * and §1.2 holds every command to being drivable through flags it declares. The variable stays for a
   * standing preference in a profile; this is for one run.
   */
  tui: boolean;
  /** Whether `--tui` was actually typed, as opposed to being its default. Only then does it beat the variable. */
  tuiExplicit?: boolean;
}

/**
 * Which renderer this run gets, and whether it may read the keyboard.
 *
 * **Plain is the answer whenever anything is uncertain**, and it is the answer for every automated
 * reader: `--json`, a pipe, and CI. The stream a plain run writes is the contract this kit publishes —
 * one line per event, no cursor movement, nothing that turns a redirected log into escape soup — so the
 * footer is what a *person at a terminal* gets, never what a consumer has to cope with.
 *
 * `keys` is reported separately and is never true on the plain path. The plain path has its own reader in
 * `terminal/keys.ts`, and two owners of raw mode is one owner too many.
 */
export function chooseRenderer(inputs: RendererInputs): { tui: boolean; keys: boolean } {
  // **The three absolute gates first.** No terminal, a machine reading the output, or a build log: a
  // footer is wrong in all three and no flag overrides them, because `--tui` into a pipe is not a
  // preference, it is a mistake.
  if (!inputs.stdoutIsTTY || inputs.json || inputs.ci || inputs.term === "dumb") {
    return { tui: false, keys: false };
  }
  // `--no-tui` is explicit and wins outright.
  if (!inputs.tui) return { tui: false, keys: false };
  // The house rule for our own variables (`CI`, `PITHY_OFFLINE`): any non-blank value is set, and set
  // but empty is not. An absent `TERM` is an unknown terminal rather than a declared-incapable one, so
  // it is not treated as `dumb`.
  const suppressed = inputs.noTui !== undefined && inputs.noTui !== "";
  // A flag typed now beats a variable configured earlier — the same reading `--app` takes over this
  // branch's autostart answer, and for the same reason: naming it outright is the more specific act.
  // `tui` is only `false` above, so reaching here with it `true` may be the default rather than typed;
  // that is why the variable still wins unless the flag was given explicitly.
  if (suppressed && !inputs.tuiExplicit) return { tui: false, keys: false };
  return { tui: true, keys: inputs.stdinIsTTY };
}

/**
 * The renderer inputs, read off this process.
 *
 * **It lives here rather than in `commands/dev.ts`, and that is the point.** All four facts are one
 * decision, and `ci/interactiveGate.test.ts` is right that a command splitting the TTY reads away from
 * the `--json` read is how something ends up rendered into a pipe. Keeping the read beside
 * {@link chooseRenderer} puts every term in one expression, in the module that already owns the rule and
 * carries its tests — the same move `commands/secrets.ts` made for the same reason, which is why neither
 * file matches that gate's scan any more.
 */
export function rendererInputsFromProcess(json: boolean, tui = true, tuiExplicit = false): RendererInputs {
  return {
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    json,
    tui,
    tuiExplicit,
    ci: isContinuousIntegration(),
    term: process.env.TERM,
    noTui: process.env.PITHY_NO_TUI,
  };
}

/**
 * Whether the footer still has to repaint.
 *
 * **`waiting` counts, and leaving it out froze the one number that mattered.** The tick advances `now`,
 * which is what a still-coming-up worker's elapsed is measured against — and `reduceSession` moves a
 * late worker from `building` to `waiting` and never back. So once the 90-second deadline fired and
 * nothing else was building, the elapsed on exactly the worrying row stopped moving, while every row
 * that had arrived kept its (correct, frozen) time-to-ready.
 */
export function ticking(workers: readonly { status: string }[]): boolean {
  return workers.some((worker) => worker.status === "building" || worker.status === "waiting");
}

/**
 * What a Ctrl-C means right now.
 *
 * - `shutdown` — the ordinary case: ask the supervisor to tear the session down.
 * - `wait` — a teardown is already in flight; the press is noted and the bar says to press again.
 * - `exit` — **there is no supervisor to ask.** The footer mounts before `startDev` resolves, so a
 *   Ctrl-C during startup reached a handle that did not exist yet: the first press did nothing at all
 *   and the second hard-exited. Exiting on the first press is the honest answer — there is nothing to
 *   ask politely — and it is deterministic rather than silent.
 */
export function interruptAction(options: { hasSession: boolean; stopping: boolean }): "shutdown" | "wait" | "exit" {
  if (!options.hasSession) return "exit";
  return options.stopping ? "exit" : "shutdown";
}
