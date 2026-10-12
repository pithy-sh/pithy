// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AsyncLocalStorage } from "node:async_hooks";
import { stripVTControlCharacters } from "node:util";

/**
 * **How a long command narrates itself. Not how provisioning does (#578).**
 *
 * This was built once already, for `pithy provision` (#515, #531): a `▸ <name>...` line as each resource
 * reached the work loop, and the settled line as it left. It worked, and then `pithy deploy` printed
 * nothing whatever for minutes while it built front ends and uploaded Workers — because the seam was
 * called `ProvisionProgress`, it lived in `provision/environment.ts`, and nothing about either said
 * *this is how a long command narrates itself*. It said *this is how provisioning narrates itself*, so
 * the second long command did not inherit it, and the first thing an operator reaches for in front of a
 * silent deploy is Ctrl-C.
 *
 * So the vocabulary is here, under no capability and no command, and it is deliberately small:
 *
 * - **A unit of work starting** — `▸ <what>...`, one plain line, printed once and never redrawn.
 * - **That unit settling** — whatever line the caller was already going to print for it.
 *
 * The pair is what an interrupted run is read back from: the last `start` with no `settled` after it
 * names what was in flight when the run stopped.
 *
 * **Ambient rather than threaded, and that is the part that makes it inherited.** A `onProgress`
 * parameter stops at the first module boundary nobody wants to change — `pithy email provision` reaches
 * its wrangler spawn through `@pithy-sh/email`'s orchestrator and a provisioner class, neither of which
 * has any business carrying a terminal concern, and threading one through them is how the eight
 * capability provisioners would each have grown their own copy of this decision. The producer raises a
 * step; the span decides whether anyone hears it. That is the whole contract.
 *
 * **The gate is `--json` and only `--json`.** It is not the `interactive` boolean the confirm prompts
 * use — that one also asks whether a TTY is attached, and a run in CI is the run whose log most needs to
 * say where it got to. A non-TTY renders these plain, exactly as the terminal seam already does with
 * color, because they *are* plain: no frames, no cursor movement, nothing that turns a redirected log
 * into escape soup.
 *
 * **`--json --events` is the one way past that gate (#697).** `deploy` and `provision` take it, and under it
 * each step is a JSON record rather than silence: {@link progressRecord} is the record, and
 * `terminal/output.ts` is the sink, because the sink frames it the way `pithy dev`'s stream is framed. A
 * producer may hand a step the structured row behind its line (`data`), which is what the record carries for
 * a machine; the line itself goes along with its paint taken out.
 */

/** One unit of work reaching, then leaving, a long command's work loop. */
export type ProgressEvent =
  /** About to start. Emitted before the first thing that could take a while. */
  | {
      phase: "start";
      /** What is being worked on — a Worker name, a capability, a resource. */
      what: string;
      /** What the producer knows about it, as keys an `--events` record carries. Never printed as text. */
      data?: Record<string, unknown>;
    }
  /** Settled: done, failed, or skipped. Carries the line the command would print for it either way. */
  | {
      phase: "settled";
      /** The caller's own summary line for this unit, printed as it settles rather than at the end. */
      line: string;
      /** The row the line summarizes, as keys an `--events` record carries. Never printed as text. */
      data?: Record<string, unknown>;
    };

/**
 * Where a run narrates itself. **Synchronous and returning nothing**, deliberately: it writes a line to a
 * terminal, and a sink that could fail or block would put the operator's console in the failure path of
 * deploying a Worker. A caller with nothing to say installs none, which is what `--json` does.
 */
export type Progress = (event: ProgressEvent) => void;

/**
 * An operation in progress: `▸ <what>...` (docs/CLI.md §3.1).
 *
 * The arrow and the body stay in the terminal's own foreground — §3.4 gives this line no tier, because
 * a color forced here is a color wrong in somebody's theme. The trailing `...` is what marks it as
 * unfinished, and it never appears on a line that reports a completed thing.
 *
 * **A plain line, printed once, never redrawn.** A repainting spinner collapses a run's history into one
 * line, which is precisely the history these exist to leave behind, and writes cursor escapes into every
 * CI log. Saffron's spinner glyphs stay reserved for a single indivisible wait.
 */
export function formatStep(what: string): string {
  return `▸ ${what}...`;
}

/**
 * **Where a run narrates itself, or nothing at all.**
 *
 * The gate is `--json` and only `--json`: every command is agent-drivable, and a machine reads exactly
 * one line — unless it asked for `--events`, whose sink is `terminal/output.ts`'s `eventsProgress`.
 */
export function commandProgress(options: { json: boolean }): Progress | undefined {
  if (options.json) return undefined;
  return (event) => {
    process.stdout.write(`${event.phase === "start" ? formatStep(event.what) : event.line}\n`);
  };
}

/**
 * One step as an `--events` record for `command`: `{ command, event: "start", what, … }` or
 * `{ command, event: "settled", line, … }`, with the producer's `data` beside. The line loses its paint here —
 * a settled line is red when it failed, and an escape byte in a stream a program parses is corruption.
 *
 * **The framing is written last, so it is the record's whatever `data` holds.** A reader dispatches on
 * `command` and `event`; a producer's row with a key of either name must not turn a settle into a start.
 */
export function progressRecord(command: string, event: ProgressEvent): Record<string, unknown> {
  return event.phase === "start"
    ? { ...event.data, command, event: "start", what: event.what }
    : { ...event.data, command, event: "settled", line: stripVTControlCharacters(event.line) };
}

/** The sink for the span currently running, if any. */
const CURRENT = new AsyncLocalStorage<Progress>();

/** A span that was handed no sink. Installed rather than left empty, so `--json` silences a nested span. */
const SILENT: Progress = () => {};

/**
 * Run `work` with `progress` installed as the sink every step inside it reaches.
 *
 * `undefined` installs silence rather than inheriting whatever an enclosing span set, because the one
 * caller that passes `undefined` is a `--json` run without `--events`, and the one line it writes must stay
 * the only one.
 */
export function narrate<T>(progress: Progress | undefined, work: () => Promise<T>): Promise<T> {
  return CURRENT.run(progress ?? SILENT, work);
}

/**
 * **A unit of work is starting.** Raised by whoever is about to spawn, upload, or wait — outside a
 * narrated span it is silent, never fatal: a producer is not entitled to know whether anyone is reading.
 */
export function startStep(what: string, data?: Record<string, unknown>): void {
  CURRENT.getStore()?.({ phase: "start", what, ...(data === undefined ? {} : { data }) });
}

/**
 * **That unit has settled**, as the line the command would otherwise have held until the summary — and, for
 * an `--events` reader, the row the line was written from.
 */
export function settleStep(line: string, data?: Record<string, unknown>): void {
  CURRENT.getStore()?.({ phase: "settled", line, ...(data === undefined ? {} : { data }) });
}
